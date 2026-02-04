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

// --- CHAT (SOCKET.IO) ---
io.on('connection', (socket) => {
  socket.on('join_room', async (data) => {
    const room = typeof data === 'string' ? data : data.room;
    const username = (data && data.user) ? data.user : 'Visitante';
    socket.join(room);
    socket.currentRoom = room;
    socket.username = username;
    if (!roomUsers[room]) roomUsers[room] = [];
    if (!roomUsers[room].includes(username)) roomUsers[room].push(username);
    io.to(room).emit('room_users', { count: roomUsers[room].length, users: roomUsers[room] });
    try {
      const messages = await db('messages').where({ room: String(room) }).orderBy('created_at', 'asc').limit(50);
      socket.emit('previous_messages', messages);
    } catch (err) { console.log("Erro chat:", err.message); }
  });

  socket.on('send_message', async (data) => {
    try {
      const userRecord = await db('users').where({ username: data.user }).first();
      const userAvatar = userRecord?.avatar_url || 'https://www.pngall.com/wp-content/uploads/5/Profile-Avatar-PNG.png';
      const [insertedMsg] = await db('messages').insert({
        room: String(data.room), user: String(data.user), text: String(data.text),
        aura_color: userRecord?.aura_color || '#ffffff', aura_name: data.aura_name || 'Iniciante',
        avatar_url: userAvatar, role: userRecord?.role || 'user',
        sender_id: data.sender_id || userRecord?.id, receiver_id: data.receiver_id || null, created_at: new Date()
      }).returning('*');
      io.to(data.room).emit('receive_message', insertedMsg);
    } catch (err) { console.error("Erro msg:", err.message); }
  });

  socket.on('disconnect', () => {
    const { currentRoom, username } = socket;
    if (currentRoom && roomUsers[currentRoom]) {
      roomUsers[currentRoom] = roomUsers[currentRoom].filter(u => u !== username);
      io.to(currentRoom).emit('room_users', { count: roomUsers[currentRoom].length, users: roomUsers[currentRoom] });
    }
  });
});

// --- ROTA DE LOGIN (COM DEBUG) ---
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const cleanEmail = email.trim().toLowerCase();
    
    console.log(`[LOGIN ATTEMPT] Email: ${cleanEmail}`);

    const user = await db('users').where({ email: cleanEmail }).first();

    if (!user) {
      console.log(`[LOGIN ERROR] Usuário não encontrado no banco: ${cleanEmail}`);
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    console.log(`[LOGIN DEBUG] Senha digitada confere com o hash? ${isMatch}`);

    if (!isMatch) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    console.log(`[LOGIN SUCCESS] Usuário ${user.username} logado.`);
    res.json({ token, user });
  } catch (err) {
    console.error("[LOGIN CRITICAL ERR]", err);
    res.status(500).json({ error: "Erro interno." });
  }
});

// --- RESTO DAS ROTAS (XP, REGISTER, PROFILE, POSTS, etc.) ---
app.post('/users/:id/update-xp', async (req, res) => {
  const { id } = req.params;
  const { xpToAdd } = req.body;
  try {
    const user = await db('users').where({ id }).first();
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    const isStaff = user.role === 'admin' || user.role === 'staff';
    let multiplier = isStaff ? 10 : 1;
    if (!isStaff) {
      const boost = await db('user_inventory').join('shop_items', 'user_inventory.item_id', 'shop_items.id')
        .where('user_inventory.user_id', id).where('shop_items.category', 'boost').first();
      if (boost) multiplier = 2;
    }
    const finalXp = Number(user.xp || 0) + ((xpToAdd || 5) * multiplier);
    await db('users').where({ id }).update({ xp: finalXp });
    res.json({ success: true, xp: finalXp, isStaffMode: isStaff });
  } catch (err) { res.status(500).json({ error: "Erro XP" }); }
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

// ADICIONE ESTA ROTA DE EMERGÊNCIA PARA TESTAR O USER 5
app.get('/force-pass-5', async (req, res) => {
  const hash = await bcrypt.hash('123456', 10);
  await db('users').where({ id: 5 }).update({ password: hash });
  res.send("Senha do user 5 resetada para 123456 via servidor!");
});


// Adicione isso no seu server.js
app.get('/users/:id/contacts', async (req, res) => {
  try {
    const { id } = req.params;
    // Busca quem o usuário segue (seguidores mútuos ou apenas seguidos)
    const contacts = await db('follows')
      .join('users', 'follows.following_id', 'users.id')
      .where('follows.follower_id', id)
      .select('users.id', 'users.username', 'users.avatar_url', 'users.aura_color');
    
    res.json(contacts);
  } catch (err) {
    console.error("Erro ao buscar contatos:", err);
    res.status(500).json({ error: "Erro ao buscar contatos" });
  }
});

// ROTA PARA PARAR DE SEGUIR (UNFOLLOW)
// ROTA SEGUIR
app.post('/users/follow', async (req, res) => {
  try {
    const { follower_id, following_id } = req.body;
    // Evita duplicados
    const exists = await db('follows').where({ follower_id, following_id }).first();
    if (!exists) {
      await db('follows').insert({ follower_id, following_id });
    }
    res.json({ success: true, followed: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao seguir" });
  }
});

// ROTA PARAR DE SEGUIR
app.post('/users/unfollow', async (req, res) => {
  try {
    const { follower_id, following_id } = req.body;
    await db('follows').where({ follower_id, following_id }).del();
    res.json({ success: true, followed: false });
  } catch (err) {
    res.status(500).json({ error: "Erro ao unfollow" });
  }
});
app.get('/', (req, res) => res.json({ status: "online" }));
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Porta ${PORT}`));