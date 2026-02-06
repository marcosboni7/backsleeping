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

const uploadFields = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
  { name: 'avatar', maxCount: 1 }
]);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- FUNÇÃO AUXILIAR: STREAM UPLOAD ---
const streamUpload = (buffer, folder, resourceType) => {
  return new Promise((resolve, reject) => {
    const options = { folder, resource_type: resourceType };
    if (resourceType === 'video') options.chunk_size = 6000000;
    else options.transformation = [{ quality: "auto" }];

    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (result) resolve(result); else reject(error);
    });
    stream.end(buffer);
  });
};

const roomUsers = {}; 

// --- CHAT (SOCKET.IO) - ATUALIZADO ---
io.on('connection', (socket) => {
  const userId = socket.handshake.query.userId;
  if (userId) {
    socket.join(`user_${userId}`);
    console.log(`📡 Usuário ${userId} sintonizado no canal privado.`);
  }

  socket.on('join_room', async (data) => {
    // Correção: Garante que room seja string e trata erro para destravar o app
    const room = String(typeof data === 'string' ? data : data.room);
    const username = (data && data.user) ? data.user : 'Visitante';
    
    socket.join(room);
    socket.currentRoom = room;
    socket.username = username;

    if (!roomUsers[room]) roomUsers[room] = [];
    if (!roomUsers[room].includes(username)) roomUsers[room].push(username);
    
    io.to(room).emit('room_users', { count: roomUsers[room].length, users: roomUsers[room] });
    
    try {
      const messages = await db('messages')
        .where({ room: room })
        .orderBy('created_at', 'asc')
        .limit(50);
      
      // Envia o histórico (Para o carregamento infinito no App)
      socket.emit('previous_messages', messages);
    } catch (err) { 
      console.log("Erro ao carregar histórico:", err.message);
      socket.emit('previous_messages', []); // Envia vazio para destravar o loading
    }
  });

  socket.on('send_message', async (data) => {
    try {
      const userRecord = await db('users').where({ username: data.user }).first();
      const userAvatar = userRecord?.avatar_url || 'https://www.pngall.com/wp-content/uploads/5/Profile-Avatar-PNG.png';
      
      const messageData = {
        room: String(data.room), 
        user: String(data.user), 
        text: String(data.text), // Mantido como text para o frontend ler
        aura_color: userRecord?.aura_color || '#ffffff', 
        aura_name: data.aura_name || 'Iniciante',
        avatar_url: userAvatar, 
        role: userRecord?.role || 'user',
        sender_id: data.sender_id || userRecord?.id, 
        receiver_id: data.receiver_id || null, 
        created_at: new Date()
      };

      // Salva no banco
      await db('messages').insert(messageData);

      // Envia para a sala aberta
      io.to(String(data.room)).emit('receive_message', messageData);

      // Notificação e atualização de lista para o destinatário
      if (data.receiver_id) {
        io.emit(`notification_${data.receiver_id}`, {
          title: "Nova Mensagem",
          message: `@${data.user} te enviou uma transmissão!`
        });
        io.emit(`new_message_${data.receiver_id}`, messageData);
      }
    } catch (err) { 
      console.error("Erro ao processar mensagem:", err.message); 
    }
  });

  socket.on('disconnect', () => {
    const { currentRoom, username } = socket;
    if (currentRoom && roomUsers[currentRoom]) {
      roomUsers[currentRoom] = roomUsers[currentRoom].filter(u => u !== username);
      io.to(currentRoom).emit('room_users', { count: roomUsers[currentRoom].length, users: roomUsers[currentRoom] });
    }
  });
});

// --- ROTA DE LOGIN ---
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const cleanEmail = email.trim().toLowerCase();
    const user = await db('users').where({ email: cleanEmail }).first();
    if (!user) return res.status(401).json({ error: "Credenciais inválidas" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: "Credenciais inválidas" });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) { res.status(500).json({ error: "Erro interno." }); }
});

// --- ROTA DE REGISTRO ---
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

// --- ROTA DE CONTATOS (SISTEMA DE MENSAGENS + FOLLOWS) ---
app.get('/users/:id/contacts', async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const messages = await db('messages')
      .where('sender_id', userId)
      .orWhere('receiver_id', userId)
      .select('sender_id', 'receiver_id');

    const followingIds = await db('follows')
      .where('follower_id', userId)
      .pluck('following_id');

    const contactIds = new Set();
    messages.forEach(msg => {
      const sId = Number(msg.sender_id);
      const rId = Number(msg.receiver_id);
      if (sId !== userId) contactIds.add(sId);
      if (rId !== userId) contactIds.add(rId);
    });
    followingIds.forEach(id => contactIds.add(Number(id)));

    const finalIds = Array.from(contactIds);
    if (finalIds.length === 0) return res.json([]);

    const contacts = await db('users').whereIn('id', finalIds).select('id', 'username', 'avatar_url');

    const formatted = contacts.map(c => {
      const isFollowing = followingIds.includes(c.id);
      return {
        ...c,
        isRequest: !isFollowing,
        accepted: isFollowing
      };
    });
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar contatos" });
  }
});

// --- ROTAS DE SEGUIR / UNFOLLOW ---
app.post('/users/follow', async (req, res) => {
  try {
    const { follower_id, following_id } = req.body;
    const exists = await db('follows').where({ follower_id, following_id }).first();
    if (!exists) await db('follows').insert({ follower_id, following_id });
    res.json({ success: true, followed: true });
  } catch (err) { res.status(500).json({ error: "Erro ao seguir" }); }
});

app.post('/users/unfollow', async (req, res) => {
  try {
    const { follower_id, following_id } = req.body;
    await db('follows').where({ follower_id, following_id }).del();
    res.json({ success: true, followed: false });
  } catch (err) { res.status(500).json({ error: "Erro ao unfollow" }); }
});

// --- PERFIL ---
app.get('/users/:id/profile', async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const currentUserId = Number(req.query.currentUserId);
    const user = await db('users').where({ id: targetId }).first();
    if(!user) return res.status(404).json({error: "Não encontrado"});
    
    let isBlocked = false;
    if (currentUserId) {
      const check = await db('blocks').where({ blocker_id: currentUserId, blocked_id: targetId }).first();
      isBlocked = !!check;
    }

    const followers = await db('follows').where({ following_id: targetId }).count('id as count').first();
    const following = await db('follows').where({ follower_id: targetId }).count('id as count').first();
    
    let isFollowing = false;
    if (currentUserId && !isBlocked) {
      const fCheck = await db('follows').where({ follower_id: currentUserId, following_id: targetId }).first();
      isFollowing = !!fCheck;
    }
    res.json({ ...user, followers: parseInt(followers.count || 0), following: parseInt(following.count || 0), isFollowing, isBlocked });
  } catch (err) { res.status(500).json({ error: "Erro perfil" }); }
});

// --- POSTS ---
app.get('/posts', async (req, res) => {
  try {
    const { userId, userIdVisitado, search, tags } = req.query; 
    const currentUserId = (userId && userId !== 'undefined') ? Number(userId) : 0;
    let query = db('posts').join('users', 'posts.user_id', 'users.id')
      .select('posts.*', 'users.username', 'users.avatar_url', 'users.aura_color',
        db.raw('(SELECT COUNT(*) FROM likes WHERE post_id = posts.id) as likes_count'),
        db.raw(`EXISTS(SELECT 1 FROM likes WHERE post_id = posts.id AND user_id = ?) as user_liked`, [currentUserId])
      );
    if (currentUserId) query = query.whereNotIn('posts.user_id', function() { this.select('blocked_id').from('blocks').where('blocker_id', currentUserId); });
    if (userIdVisitado) query = query.where('posts.user_id', Number(userIdVisitado));
    if (tags) query = query.where('posts.tags', 'like', `%${tags.toLowerCase()}%`);
    const posts = await query.orderBy('posts.created_at', 'desc');
    res.json(posts);
  } catch (err) { res.status(500).json({ error: "Erro posts" }); }
});

// --- XP SYSTEM ---
app.post('/users/:id/update-xp', async (req, res) => {
  const { id } = req.params;
  const { xpToAdd } = req.body;
  try {
    const user = await db('users').where({ id }).first();
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    const isStaff = user.role === 'admin' || user.role === 'staff';
    let multiplier = isStaff ? 10 : 1;
    const finalXp = Number(user.xp || 0) + ((xpToAdd || 5) * multiplier);
    await db('users').where({ id }).update({ xp: finalXp });
    res.json({ success: true, xp: finalXp, isStaffMode: isStaff });
  } catch (err) { res.status(500).json({ error: "Erro XP" }); }
});

// --- BLOQUEIOS ---
app.post('/users/block', async (req, res) => {
  try {
    const { blocker_id, blocked_id } = req.body;
    await db('blocks').insert({ blocker_id, blocked_id, created_at: new Date() });
    await db('follows').where({ follower_id: blocker_id, following_id: blocked_id }).orWhere({ follower_id: blocked_id, following_id: blocker_id }).del();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Erro block" }); }
});

app.post('/users/unblock', async (req, res) => {
  try {
    const { blocker_id, blocked_id } = req.body;
    await db('blocks').where({ blocker_id, blocked_id }).del();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Erro unblock" }); }
});
// --- ROTA DA LOJA (CONECTANDO COM O QUE JÁ TEM NA DB) ---
app.get('/products', async (req, res) => {
  try {
    // Aqui buscamos da tabela que você já criou
    const products = await db('products').select('*');
    
    // Log para você conferir no terminal do PC se os dados estão vindo
    console.log(`📦 Itens carregados da DB: ${products.length}`);
    
    res.json(products);
  } catch (err) { 
    console.error("❌ Erro ao acessar tabela de produtos:", err.message);
    res.status(500).json({ error: "Erro ao carregar loja" }); 
  }
});
// --- ROTA PADRÃO ---
app.get('/', (req, res) => res.json({ status: "online", aura: "active" }));

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Sleeping Chat rodando na porta ${PORT}`));