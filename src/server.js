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

// --- CONFIGURAÇÃO CLOUDINARY (CHAVES QUE VOCÊ PASSOU) ---
cloudinary.config({
  cloud_name: 'dq2fscjki',
  api_key: '745961655688624',
  api_secret: 'gVxVRpYSaKwzbhqv0_1E56SFcQ0'
});

// Configuração do Storage para Multer falar com Cloudinary
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'aura_media',
    resource_type: 'auto', // Aceita vídeo e imagem
    allowed_formats: ['jpg', 'png', 'mp4', 'mov', 'jpeg']
  },
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

const uploadFields = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
  { name: 'avatar', maxCount: 1 }
]);

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// --- LÓGICA DO CHAT (SOCKET.IO) ---
io.on('connection', (socket) => {
  console.log('🛸 Viajante conectado ao Socket:', socket.id);

  socket.on('join_room', async (roomName) => {
    socket.join(roomName);
    try {
      const messages = await db('messages')
        .where({ room: roomName })
        .orderBy('created_at', 'asc')
        .limit(50);
      socket.emit('previous_messages', messages);
    } catch (err) {
      console.log("Erro histórico:", err.message);
    }
  });

  socket.on('send_message', async (data) => {
    try {
      const userRecord = await db('users').where({ username: data.user }).first();
      const messageToSave = {
        room: String(data.room),
        user: String(data.user),
        text: String(data.text),
        aura_color: userRecord?.aura_color || '#ffffff',
        aura_name: userRecord?.xp >= 1000 ? 'Mestre' : 'Iniciante',
        role: userRecord?.role || 'user',
        created_at: new Date()
      };
      const [insertedMsg] = await db('messages').insert(messageToSave).returning('*');
      io.to(data.room).emit('receive_message', insertedMsg);
    } catch (err) {
      console.error("❌ Erro ao salvar mensagem:", err.message);
    }
  });

  socket.on('disconnect', () => console.log('👤 Viajante saiu.'));
});

// --- AUTENTICAÇÃO ---
app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const [newUser] = await db('users').insert({
      username, email, password: hashedPassword,
      balance: 1000, role: 'user', xp: 0, aura_color: '#ffffff'
    }).returning('*');
    res.status(201).json({ message: "Usuário criado!", user: { id: newUser.id, username: newUser.username } });
  } catch (err) { res.status(400).json({ error: "Erro ao registrar." }); }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await db('users').where({ email }).first();
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) return res.status(401).json({ error: "Senha incorreta" });
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) { res.status(500).json({ error: "Erro no servidor" }); }
});

// --- COMENTÁRIOS (ROTA BLINDADA) ---
app.post('/posts/:id/comments', async (req, res) => {
  const post_id = parseInt(req.params.id);
  const user_id = parseInt(req.body.user_id);
  const { content } = req.body;

  if (isNaN(post_id) || isNaN(user_id)) return res.status(400).json({ error: "ID inválido" });

  try {
    const [newComment] = await db('comments').insert({ post_id, user_id, content }).returning('*');
    const commentWithUser = await db('comments')
      .join('users', 'comments.user_id', 'users.id')
      .where('comments.id', newComment.id)
      .select('comments.*', 'users.username', 'users.avatar_url', 'users.aura_color').first();
    res.status(201).json(commentWithUser);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/posts/:id/comments', async (req, res) => {
  try {
    const comments = await db('comments').join('users', 'comments.user_id', 'users.id')
      .where({ post_id: Number(req.params.id) })
      .select('comments.*', 'users.username', 'users.avatar_url', 'users.aura_color')
      .orderBy('created_at', 'asc');
    res.json(comments);
  } catch (err) { res.status(500).json({ error: "Erro comentários" }); }
});

// --- PERFIL (COM CLOUDINARY) ---
app.put('/users/:id', uploadFields, async (req, res) => {
  const { id } = req.params;
  const { username, bio } = req.body;
  try {
    const dataToUpdate = { username, bio };
    if (req.files && req.files['avatar']) {
      dataToUpdate.avatar_url = req.files['avatar'][0].path; // URL DO CLOUDINARY
    }
    const [updatedUser] = await db('users').where({ id }).update(dataToUpdate).returning('*');
    res.json({ message: "Sua essência foi atualizada!", user: updatedUser });
  } catch (err) { res.status(500).json({ error: "Falha ao atualizar perfil." }); }
});

app.get('/users/:id/profile', async (req, res) => {
  const targetId = Number(req.params.id);
  const currentUserId = Number(req.query.currentUserId);
  try {
    const user = await db('users').where({ id: targetId }).first();
    const followersCount = await db('follows').where({ following_id: targetId }).count('id as count').first();
    const followingCount = await db('follows').where({ follower_id: targetId }).count('id as count').first();
    let isFollowing = false;
    if (currentUserId) {
        const followCheck = await db('follows').where({ follower_id: currentUserId, following_id: targetId }).first();
        isFollowing = !!followCheck;
    }
    res.json({ ...user, followers: parseInt(followersCount?.count || 0), following: parseInt(followingCount?.count || 0), isFollowing });
  } catch (err) { res.status(500).json({ error: "Erro perfil" }); }
});

// --- POSTS (COM CLOUDINARY) ---
app.post('/posts/upload', uploadFields, async (req, res) => {
  const { userId, title, description } = req.body;
  try {
    const videoUrl = req.files['video'] ? req.files['video'][0].path : null;
    const thumbUrl = req.files['thumbnail'] ? req.files['thumbnail'][0].path : null;
    
    if (!videoUrl) return res.status(400).json({ error: "O vídeo é obrigatório." });

    const [newPost] = await db('posts').insert({
      user_id: userId, title, description,
      media_url: videoUrl, // URL DO CLOUDINARY
      thumbnail_url: thumbUrl, // URL DO CLOUDINARY
      type: 'video'
    }).returning('*');
    res.status(201).json(newPost);
  } catch (err) { res.status(500).json({ error: "Erro upload" }); }
});

app.get('/posts', async (req, res) => {
  const { userId, userIdVisitado } = req.query; 
  const currentUserId = userId && userId !== 'undefined' ? Number(userId) : 0;
  try {
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

// --- LIKES ---
app.post('/posts/:id/like', async (req, res) => {
    const postId = req.params.id;
    const { userId } = req.body;
    try {
        const existingLike = await db('likes').where({ user_id: userId, post_id: postId }).first();
        if (existingLike) {
            await db('likes').where({ user_id: userId, post_id: postId }).del();
            return res.json({ liked: false });
        } else {
            await db('likes').insert({ user_id: userId, post_id: postId });
            return res.json({ liked: true });
        }
    } catch (err) { res.status(500).json({ error: "Erro likes" }); }
});

// --- INICIALIZAÇÃO ---
app.get('/', (req, res) => res.send('🌌 Santuário Aura Online!'));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AURA BACK-END ONLINE NA PORTA ${PORT}`);
});