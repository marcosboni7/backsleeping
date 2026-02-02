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
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Usamos memoryStorage para não gravar nada no disco limitado do Render
const storage = multer.memoryStorage();
const upload = multer({ storage });

const uploadFields = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
  { name: 'avatar', maxCount: 1 }
]);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- FUNÇÃO DE UPLOAD VIA STREAM (O SEGREDO PARA NÃO DAR ERRO) ---
const streamUpload = (buffer, folder, resourceType) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { 
        folder: folder, 
        resource_type: resourceType,
        // Forçamos uma compressão leve para o vídeo fluir melhor
        transformation: [{ quality: "auto", fetch_format: "mp4" }] 
      },
      (error, result) => {
        if (result) resolve(result);
        else reject(error);
      }
    );
    stream.end(buffer);
  });
};

// --- ROTA DE UPLOAD REESCRITA ---
app.post('/posts/upload', uploadFields, async (req, res) => {
  try {
    const { userId, title, description } = req.body;
    
    if (!req.files || !req.files['video']) {
      return res.status(400).json({ error: "O vídeo é obrigatório." });
    }

    console.log("📡 Iniciando Stream Estelar para o Cloudinary...");

    // 1. Upload do Vídeo (Direto da memória para a nuvem)
    const videoResult = await streamUpload(
      req.files['video'][0].buffer, 
      'aura_posts', 
      'video'
    );

    // 2. Upload da Thumbnail (se existir)
    let thumbUrl = null;
    if (req.files['thumbnail']) {
      const thumbResult = await streamUpload(
        req.files['thumbnail'][0].buffer, 
        'aura_thumbs', 
        'image'
      );
      thumbUrl = thumbResult.secure_url;
    }

    // 3. Salvar no Banco de Dados
    const [newPost] = await db('posts').insert({
      user_id: Number(userId),
      title: title || "Sem título",
      description: description || "",
      media_url: videoResult.secure_url,
      thumbnail_url: thumbUrl,
      type: 'video',
      created_at: new Date()
    }).returning('*');

    console.log("✨ Jornada registrada com sucesso!");
    res.status(201).json(newPost);

  } catch (err) {
    console.error("🔥 ERRO FATAL:", err.message);
    res.status(500).json({ error: "Erro no processamento", details: err.message });
  }
});

// --- CHAT (SOCKET.IO) ---
io.on('connection', (socket) => {
  socket.on('join_room', async (roomName) => {
    socket.join(roomName);
    try {
      const messages = await db('messages').where({ room: String(roomName) }).orderBy('created_at', 'asc').limit(50);
      socket.emit('previous_messages', messages);
    } catch (err) { console.log(err.message); }
  });

  socket.on('send_message', async (data) => {
    try {
      const userRecord = await db('users').where({ username: data.user }).first();
      const [insertedMsg] = await db('messages').insert({
        room: String(data.room),
        user: String(data.user),
        text: String(data.text),
        aura_color: userRecord?.aura_color || '#ffffff',
        created_at: new Date()
      }).returning('*');
      io.to(data.room).emit('receive_message', insertedMsg);
    } catch (err) { console.error(err.message); }
  });
});

// --- AUTH (LOGIN/REGISTER) ---
app.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const [newUser] = await db('users').insert({
      username, email, password: hashedPassword, balance: 1000, role: 'user', xp: 0, aura_color: '#ffffff'
    }).returning('*');
    res.status(201).json(newUser);
  } catch (err) { res.status(400).json({ error: "Erro ao criar usuário" }); }
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await db('users').where({ email }).first();
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: "Falha" });
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) { res.status(500).json({ error: "Erro" }); }
});

// --- FEED ---
app.get('/posts', async (req, res) => {
  try {
    const posts = await db('posts')
      .join('users', 'posts.user_id', 'users.id')
      .select('posts.*', 'users.username', 'users.avatar_url', 'users.aura_color')
      .orderBy('posts.created_at', 'desc');
    res.json(posts);
  } catch (err) { res.status(500).json({ error: "Erro ao buscar" }); }
});

app.get('/', (req, res) => res.json({ status: "online" }));

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Porta ${PORT}`));