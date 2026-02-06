const express = require('express');
const cors = require('cors');
const db = require('./config/db'); 
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer'); 
const http = require('http'); 
const { Server } = require('socket.io'); 
const cloudinary = require('cloudinary').v2;

const app = express();
const server = http.createServer(app); 
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3333; 
const JWT_SECRET = process.env.JWT_SECRET || 'minha_chave_galatica_secreta';

// --- CONFIGURAÇÃO CLOUDINARY ---
cloudinary.config({
  cloud_name: (process.env.CLOUDINARY_CLOUD_NAME || 'dmzukpnxz').trim(),
  api_key: (process.env.CLOUDINARY_API_KEY || '').trim(),
  api_secret: (process.env.CLOUDINARY_API_SECRET || '').trim()
});

const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } 
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const roomUsers = {}; 

// --- CHAT (SOCKET.IO) ---
io.on('connection', (socket) => {
  const userId = socket.handshake.query.userId;
  if (userId) {
    socket.join(`user_${userId}`);
  }

  socket.on('join_room', async (data) => {
    const room = String(typeof data === 'string' ? data : data.room);
    const username = (data && data.user) ? data.user : 'Visitante';
    
    socket.join(room);
    socket.currentRoom = room;
    socket.username = username;

    if (!roomUsers[room]) roomUsers[room] = [];
    if (!roomUsers[room].includes(username)) roomUsers[room].push(username);
    
    io.to(room).emit('room_users', { count: roomUsers[room].length, users: roomUsers[room] });
    
    try {
      const messages = await db('messages').where({ room: room }).orderBy('created_at', 'asc').limit(50);
      socket.emit('previous_messages', messages);
    } catch (err) { 
      socket.emit('previous_messages', []); 
    }
  });

  socket.on('send_message', async (data) => {
    try {
      const userRecord = await db('users').where({ username: data.user }).first();
      const messageData = {
        room: String(data.room), 
        user: String(data.user), 
        text: String(data.text), 
        aura_color: userRecord?.aura_color || '#ffffff', 
        avatar_url: userRecord?.avatar_url || 'https://www.pngall.com/wp-content/uploads/5/Profile-Avatar-PNG.png', 
        role: userRecord?.role || 'user',
        sender_id: data.sender_id || userRecord?.id, 
        receiver_id: data.receiver_id || null, 
        created_at: new Date()
      };
      await db('messages').insert(messageData);
      io.to(String(data.room)).emit('receive_message', messageData);
      if (data.receiver_id) {
        io.emit(`notification_${data.receiver_id}`, { title: "Nova Mensagem", message: `@${data.user} enviou uma transmissão!` });
        io.emit(`new_message_${data.receiver_id}`, messageData);
      }
    } catch (err) { console.error("Erro mensagem:", err.message); }
  });

  socket.on('disconnect', () => {
    const { currentRoom, username } = socket;
    if (currentRoom && roomUsers[currentRoom]) {
      roomUsers[currentRoom] = roomUsers[currentRoom].filter(u => u !== username);
      io.to(currentRoom).emit('room_users', { count: roomUsers[currentRoom].length, users: roomUsers[currentRoom] });
    }
  });
});

// --- AUTENTICAÇÃO ---
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await db('users').where({ email: email.trim().toLowerCase() }).first();
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: "Credenciais inválidas" });
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) { res.status(500).json({ error: "Erro interno." }); }
});

app.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const [newUser] = await db('users').insert({
      username, email: email.toLowerCase().trim(), password: hashedPassword,
      balance: 1000, role: 'user', xp: 0, aura_color: '#ffffff'
    }).returning('*');
    res.status(201).json({ message: "Usuário criado!", user: newUser });
  } catch (err) { res.status(400).json({ error: "Erro no cadastro." }); }
});

// --- LOJA E INVENTÁRIO (SISTEMA DE MOEDAS INTERNAS) ---

app.get('/shop', async (req, res) => {
  try {
    const items = await db('products').select('*');
    res.json(items);
  } catch (err) { res.status(500).json({ error: "Erro ao carregar a loja." }); }
});

app.post('/shop/buy', async (req, res) => {
  const { userId, itemId } = req.body;
  console.log(`🛒 Tentativa de compra: User ${userId}, Item ${itemId}`);
  
  try {
    const user = await db('users').where({ id: userId }).first();
    const item = await db('products').where({ id: itemId }).first();

    if (!user) {
      console.log("❌ Erro: Usuário não encontrado no banco.");
      return res.status(404).json({ error: "Usuário não encontrado." });
    }
    if (!item) {
      console.log("❌ Erro: Item não encontrado na tabela products.");
      return res.status(404).json({ error: "Item não encontrado." });
    }

    if (Number(user.balance) < Number(item.price)) {
      console.log(`❌ Erro: Saldo insuficiente. User tem ${user.balance}, item custa ${item.price}`);
      return res.status(400).json({ error: "Saldo insuficiente!" });
    }

    await db.transaction(async (trx) => {
      console.log("⚙️ Iniciando transação no banco...");
      
      // 1. Deduz o saldo
      await trx('users').where({ id: userId }).update({ 
        balance: Number(user.balance) - Number(item.price) 
      });

      // 2. Insere no inventário
      // ATENÇÃO: Se der erro aqui, verifique se a coluna é acquired_at ou created_at
      await trx('inventory').insert({ 
        user_id: userId, 
        item_id: itemId, 
        acquired_at: new Date() 
      });
      
      console.log("✅ Transação concluída com sucesso.");
    });

    const updatedUser = await db('users').where({ id: userId }).first();
    res.json({ success: true, user: updatedUser });

  } catch (err) {
    console.error("🔥 ERRO CRÍTICO NA COMPRA:", err.message);
    console.error("Dica: Verifique se as tabelas 'products' e 'inventory' existem e se as colunas estão corretas.");
    res.status(500).json({ error: "Erro interno no servidor.", details: err.message });
  }
});

app.get('/users/:id/inventory', async (req, res) => {
  try {
    const myItems = await db('inventory')
      .join('products', 'inventory.item_id', 'products.id')
      .where('inventory.user_id', req.params.id)
      .select('products.*', 'inventory.id as inventory_id');
    res.json(myItems);
  } catch (err) { res.json([]); }
});

app.post('/users/equip-aura', async (req, res) => {
  try {
    const { userId, color } = req.body;
    await db('users').where({ id: userId }).update({ aura_color: color });
    const user = await db('users').where({ id: userId }).first();
    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ error: "Erro ao equipar." }); }
});

// --- PERFIL E SOCIAL ---
app.get('/users/:id/profile', async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const user = await db('users').where({ id: targetId }).first();
    const followers = await db('follows').where({ following_id: targetId }).count('id as count').first();
    const following = await db('follows').where({ follower_id: targetId }).count('id as count').first();
    res.json({ ...user, followers: parseInt(followers.count || 0), following: parseInt(following.count || 0) });
  } catch (err) { res.status(500).json({ error: "Erro perfil" }); }
});

app.get('/users/:id/contacts', async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const followingIds = await db('follows').where('follower_id', userId).pluck('following_id');
    const contacts = followingIds.length > 0 ? await db('users').whereIn('id', followingIds).select('id', 'username', 'avatar_url') : [];
    res.json(contacts);
  } catch (err) { res.status(500).json({ error: "Erro contatos" }); }
});

app.post('/users/follow', async (req, res) => {
  try {
    const { follower_id, following_id } = req.body;
    await db('follows').insert({ follower_id, following_id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Erro follow" }); }
});

// --- POSTS ---
app.get('/posts', async (req, res) => {
  try {
    const posts = await db('posts')
      .join('users', 'posts.user_id', 'users.id')
      .select('posts.*', 'users.username', 'users.avatar_url', 'users.aura_color')
      .orderBy('posts.created_at', 'desc');
    res.json(posts);
  } catch (err) { res.status(500).json({ error: "Erro posts" }); }
});

// --- XP SYSTEM ---
app.post('/users/:id/update-xp', async (req, res) => {
  try {
    const user = await db('users').where({ id: req.params.id }).first();
    const multiplier = (user.role === 'admin' || user.role === 'staff') ? 10 : 1;
    const finalXp = Number(user.xp || 0) + (5 * multiplier);
    await db('users').where({ id: req.params.id }).update({ xp: finalXp });
    res.json({ success: true, xp: finalXp });
  } catch (err) { res.status(500).json({ error: "Erro XP" }); }
});

// --- ROTA PADRÃO ---
app.get('/', (req, res) => res.json({ status: "online", aura: "active" }));

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Sleeping Chat rodando na porta ${PORT}`));