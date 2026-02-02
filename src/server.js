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

// --- CONFIGURAÇÃO CLOUDINARY COM LIMPEZA DE ESPAÇOS (.trim()) ---
cloudinary.config({
  cloud_name: (process.env.CLOUDINARY_CLOUD_NAME || '').trim(),
  api_key: (process.env.CLOUDINARY_API_KEY || '').trim(),
  api_secret: (process.env.CLOUDINARY_API_SECRET || '').trim()
});

// Verificação no console do Render para diagnóstico
console.log("☁️ Cloudinary Nome:", process.env.CLOUDINARY_CLOUD_NAME ? "Configurado" : "Vazio");

// Usamos memoryStorage para não depender do disco do Render
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // Limite de 50MB
});

const uploadFields = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
  { name: 'avatar', maxCount: 1 }
]);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- FUNÇÃO DE UPLOAD VIA STREAM ---
const streamUpload = (buffer, folder, resourceType) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { 
        folder: folder, 
        resource_type: resourceType,
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

// --- ROTA DE UPLOAD ---
app.post('/posts/upload', uploadFields, async (req, res) => {
  try {
    const { userId, title, description } = req.body;
    
    if (!req.files || !req.files['video']) {
      return res.status(400).json({ error: "O vídeo é obrigatório." });
    }

    console.log("📡 Iniciando upload para Cloudinary...");

    const videoResult = await streamUpload(
      req.files['video'][0].buffer, 
      'aura_posts', 
      'video'
    );

    let thumbUrl = null;
    if (req.files['thumbnail']) {
      const thumbResult = await streamUpload(
        req.files['thumbnail'][0].buffer, 
        'aura_thumbs', 
        'image'
      );
      thumbUrl = thumbResult.secure_url;
    }

    const [newPost] = await db('posts').insert({
      user_id: Number(userId),
      title: title || "Sem título",
      description: description || "",
      media_url: videoResult.secure_url,
      thumbnail_url: thumbUrl,
      type: 'video',
      created_at: new Date()
    }).returning('*');

    res.status(201).json(newPost);
  } catch (err) {
    console.error("🔥 ERRO NO UPLOAD:", err);
    res.status(500).json({ error: "Falha no servidor", details: err.message });
  }
});

// --- DEMAIS ROTAS ---

app.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const [newUser] = await db('users').insert({
      username, email, password: hashedPassword, balance: 1000, role: 'user', xp: 0, aura_color: '#ffffff'
    }).returning('*');
    res.status(201).json(newUser);
  } catch (err) { res.status(400).json({ error: "Erro no cadastro" }); }
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

app.get('/posts', async (req, res) => {
  try {
    const posts = await db('posts')
      .join('users', 'posts.user_id', 'users.id')
      .select('posts.*', 'users.username', 'users.avatar_url', 'users.aura_color')
      .orderBy('posts.created_at', 'desc');
    res.json(posts);
  } catch (err) { res.status(500).json({ error: "Erro ao buscar posts" }); }
});

app.get('/', (req, res) => res.json({ status: "online" }));

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Porta ${PORT}`));