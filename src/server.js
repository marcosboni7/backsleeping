const express = require('express');
const cors = require('cors');
const db = require('./config/db'); 
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer'); 
const path = require('path');    
const http = require('http'); 
const { Server } = require('socket.io'); 
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const server = http.createServer(app); 
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3333; 
const JWT_SECRET = process.env.JWT_SECRET || 'minha_chave_galatica_secreta';

// --- CONFIGURAÇÃO CLOUDINARY (USANDO VARIÁVEIS DE AMBIENTE) ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'aura_media',
    resource_type: 'auto',
    allowed_formats: ['jpg', 'png', 'mp4', 'mov', 'jpeg']
  },
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 } 
});

const uploadFields = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
  { name: 'avatar', maxCount: 1 }
]);

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// --- CHAT (SOCKET.IO) ---
io.on('connection', (socket) => {
  socket.on('join_room', async (roomName) => {
    socket.join(roomName);
    try {
      const messages = await db('messages').where({ room: roomName }).orderBy('created_at', 'asc').limit(50);
      socket.emit('previous_messages', messages);
    } catch (err) { console.log("Erro chat:", err.message); }
  });

  socket.on('send_message', async (data) => {
    try {
      const userRecord = await db('users').where({ username: data.user }).first();
      const [insertedMsg] = await db('messages').insert({
        room: String(data.room),
        user: String(data.user),
        text: String(data.text),
        aura_color: userRecord?.aura_color || '#ffffff',
        aura_name: userRecord?.xp >= 1000 ? 'Mestre' : 'Iniciante',
        role: userRecord?.role || 'user',
        created_at: new Date()
      }).returning('*');
      io.to(data.room).emit('receive_message', insertedMsg);
    } catch (err) { console.error("Erro msg:", err.message); }
  });
});

// --- AUTH ---
app.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const [newUser] = await db('users').insert({
      username, email, password: hashedPassword,
      balance: 1000, role: 'user', xp: 0, aura_color: '#ffffff'
    }).returning('*');
    res.status(201).json({ message: "Usuário criado!", user: newUser });
  } catch (err) { res.status(400).json({ error: "Erro ao registrar. Email ou User já existe." }); }
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await db('users').where({ email }).first();
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) { res.status(500).json({ error: "Erro interno" }); }
});

// --- PERFIL E FOLLOWS ---
app.put('/users/:id', uploadFields, async (req, res) => {
  try {
    const { id } = req.params;
    const { username, bio } = req.body;
    const dataToUpdate = { username, bio };
    if (req.files && req.files['avatar']) {
      dataToUpdate.avatar_url = req.files['avatar'][0].path; 
    }
    const [updatedUser] = await db('users').where({ id: Number(id) }).update(dataToUpdate).returning('*');
    res.json({ message: "Atualizado!", user: updatedUser });
  } catch (err) { 
    console.error(err);
    res.status(500).json({ error: "Erro ao atualizar" }); 
  }
});

app.post('/users/:id/follow', async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const { followerId } = req.body;
    const existing = await db('follows').where({ follower_id: followerId, following_id: targetId }).first();
    if (existing) {
      await db('follows').where({ follower_id: followerId, following_id: targetId }).del();
      return res.json({ isFollowing: false });
    }
    await db('follows').insert({ follower_id: followerId, following_id: targetId });
    res.json({ isFollowing: true });
  } catch (err) { res.status(500).json({ error: "Erro follow" }); }
});

app.get('/users/:id/profile', async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const currentUserId = Number(req.query.currentUserId);
    const user = await db('users').where({ id: targetId }).first();
    if(!user) return res.status(404).json({error: "Não encontrado"});
    const followers = await db('follows').where({ following_id: targetId }).count('id as count').first();
    const following = await db('follows').where({ follower_id: targetId }).count('id as count').first();
    let isFollowing = false;
    if (currentUserId) {
      const check = await db('follows').where({ follower_id: currentUserId, following_id: targetId }).first();
      isFollowing = !!check;
    }
    res.json({ ...user, followers: parseInt(followers.count || 0), following: parseInt(following.count || 0), isFollowing });
  } catch (err) { res.status(500).json({ error: "Erro perfil" }); }
});

// --- POSTS ---
app.post('/posts/upload', uploadFields, async (req, res) => {
  try {
    const { userId, title, description } = req.body;
    const videoUrl = req.files['video'] ? req.files['video'][0].path : null;
    const thumbUrl = req.files['thumbnail'] ? req.files['thumbnail'][0].path : null;
    if (!videoUrl) return res.status(400).json({ error: "Vídeo obrigatório." });

    const [newPost] = await db('posts').insert({
      user_id: Number(userId), title, description,
      media_url: videoUrl, thumbnail_url: thumbUrl, type: 'video'
    }).returning('*');
    res.status(201).json(newPost);
  } catch (err) { res.status(500).json({ error: "Erro upload" }); }
});

app.get('/posts', async (req, res) => {
  try {
    const { userId, userIdVisitado } = req.query; 
    const currentUserId = (userId && userId !== 'undefined') ? Number(userId) : 0;
    let query = db('posts').join('users', 'posts.user_id', 'users.id')
      .select('posts.*', 'users.username', 'users.avatar_url', 'users.aura_color',
        db.raw('(SELECT COUNT(*) FROM likes WHERE post_id = posts.id) as likes_count'),
        db.raw(`EXISTS(SELECT 1 FROM likes WHERE post_id = posts.id AND user_id = ?) as user_liked`, [currentUserId])
      );
    if (userIdVisitado) query = query.where('posts.user_id', Number(userIdVisitado));
    const posts = await query.orderBy('posts.created_at', 'desc');
    res.json(posts);
  } catch (err) { res.status(500).json({ error: "Erro posts" }); }
});

// --- LIKES E COMENTÁRIOS ---
app.post('/posts/:id/like', async (req, res) => {
  try {
    const { userId } = req.body;
    const existing = await db('likes').where({ user_id: userId, post_id: req.params.id }).first();
    if (existing) {
      await db('likes').where({ user_id: userId, post_id: req.params.id }).del();
      return res.json({ liked: false });
    }
    await db('likes').insert({ user_id: userId, post_id: req.params.id });
    res.json({ liked: true });
  } catch (err) { res.status(500).json({ error: "Erro likes" }); }
});

app.post('/posts/:id/comments', async (req, res) => {
  try {
    const { user_id, content } = req.body;
    const [newComment] = await db('comments').insert({ post_id: req.params.id, user_id, content }).returning('*');
    const full = await db('comments').join('users', 'comments.user_id', 'users.id')
      .where('comments.id', newComment.id).select('comments.*', 'users.username', 'users.avatar_url', 'users.aura_color').first();
    res.status(201).json(full);
  } catch (err) { res.status(500).json({ error: "Erro comment" }); }
});

app.get('/posts/:id/comments', async (req, res) => {
  try {
    const comments = await db('comments').join('users', 'comments.user_id', 'users.id')
      .where({ post_id: req.params.id }).select('comments.*', 'users.username', 'users.avatar_url', 'users.aura_color').orderBy('created_at', 'asc');
    res.json(comments);
  } catch (err) { res.status(500).json({ error: "Erro buscando comments" }); }
});

// --- SHOP ---
app.get('/shop', async (req, res) => {
  try { res.json(await db('shop_items').select('*')); } catch (err) { res.status(500).json({ error: "Erro shop" }); }
});

app.post('/shop/buy', async (req, res) => {
  try {
    const { userId, itemId } = req.body;
    await db.transaction(async (trx) => {
      const item = await trx('shop_items').where({ id: itemId }).first();
      const user = await trx('users').where({ id: userId }).first();
      if (!user || !item) throw new Error("Item ou usuário não encontrado");
      if (user.balance < item.price) throw new Error("Saldo insuficiente!");
      const [upd] = await trx('users').where({ id: userId }).decrement('balance', item.price).returning('*');
      await trx('user_inventory').insert({ user_id: userId, item_id: itemId });
      if (item.category === 'aura') await trx('users').where({ id: userId }).update({ aura_color: item.item_value });
      res.json({ success: true, newBalance: upd.balance });
    });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Upgrade Cloudinary.
app.get('/', (req, res) => res.send('🌌 Aura Santuário Online!'));
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Porta ${PORT}`));