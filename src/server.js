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
    const options = {
      folder: folder,
      resource_type: resourceType,
    };

    if (resourceType === 'video') {
      options.chunk_size = 6000000; 
    } else {
      options.transformation = [{ quality: "auto" }];
    }

    const stream = cloudinary.uploader.upload_stream(
      options,
      (error, result) => {
        if (result) resolve(result);
        else reject(error);
      }
    );
    stream.end(buffer);
  });
};

// --- CHAT (SOCKET.IO) ---
io.on('connection', (socket) => {
  socket.on('join_room', async (roomName) => {
    socket.join(roomName);
    try {
      const messages = await db('messages')
        .where({ room: String(roomName) })
        .orderBy('created_at', 'asc')
        .limit(50);
      socket.emit('previous_messages', messages);
    } catch (err) { console.log("Erro chat:", err.message); }
  });

  socket.on('send_message', async (data) => {
    try {
      const userRecord = await db('users').where({ username: data.user }).first();
      
      let levelName = 'Iniciante';
      const userXP = userRecord?.xp || 0;
      // Níveis de Título
      if (userXP >= 10000) levelName = 'Divindade'; 
      else if (userXP >= 5000) levelName = 'Mestre Zen';
      else if (userXP >= 1000) levelName = 'Explorador';

      const [insertedMsg] = await db('messages').insert({
        room: String(data.room),
        user: String(data.user),
        text: String(data.text),
        aura_color: userRecord?.aura_color || '#ffffff',
        aura_name: levelName,
        role: userRecord?.role || 'user',
        created_at: new Date()
      }).returning('*');

      io.to(data.room).emit('receive_message', insertedMsg);
    } catch (err) { console.error("Erro msg:", err.message); }
  });
});

// --- ROTA DE XP COM MODO STAFF INFINITO ---
app.post('/users/:id/update-xp', async (req, res) => {
  const { id } = req.params;
  const { xpToAdd } = req.body;

  try {
    const user = await db('users').where({ id }).first();
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });

    const isStaff = user.role === 'admin' || user.role === 'staff';
    
    let multiplier = 1;
    if (isStaff) {
      // Staff ganha 10x mais XP (Aura Infinita/Rápida)
      multiplier = 10; 
    } else {
      // Verifica se usuário normal tem item de Boost no inventário
      const boostItem = await db('user_inventory')
        .join('shop_items', 'user_inventory.item_id', 'shop_items.id')
        .where('user_inventory.user_id', id)
        .where('shop_items.category', 'boost')
        .first();
      if (boostItem) multiplier = 2;
    }

    const finalXpGain = (xpToAdd || 5) * multiplier;
    const newXp = Number(user.xp || 0) + finalXpGain;

    await db('users').where({ id }).update({ xp: newXp });

    res.json({ 
      success: true, 
      xp: newXp, 
      gained: finalXpGain, 
      isStaffMode: isStaff 
    });
  } catch (err) {
    res.status(500).json({ error: "Erro ao atualizar XP" });
  }
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
  } catch (err) { res.status(400).json({ error: "Email ou Usuário já cadastrado." }); }
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
  } catch (err) { res.status(500).json({ error: "Erro interno." }); }
});

// --- PERFIL ---
app.put('/users/:id', uploadFields, async (req, res) => {
  const { id } = req.params;
  try {
    const { username, bio, aura_color } = req.body; 
    const dataToUpdate = {};

    if (username) dataToUpdate.username = username;
    if (bio !== undefined) dataToUpdate.bio = bio;
    if (aura_color !== undefined) dataToUpdate.aura_color = aura_color;

    if (req.files && req.files['avatar']) {
      const avatarResult = await streamUpload(req.files['avatar'][0].buffer, 'aura_avatars', 'image');
      dataToUpdate.avatar_url = avatarResult.secure_url;
    }

    const [updatedUser] = await db('users')
      .where({ id: Number(id) })
      .update(dataToUpdate)
      .returning('*');

    res.json({ message: "Perfil atualizado!", user: updatedUser });
  } catch (err) { res.status(500).json({ error: "Erro ao atualizar perfil." }); }
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
  } catch (err) { res.status(500).json({ error: "Erro ao buscar perfil." }); }
});

// --- POSTS ---
app.post('/posts/upload', uploadFields, async (req, res) => {
  try {
    const { userId, title, description } = req.body;
    if (!req.files || !req.files['video']) return res.status(400).json({ error: "Vídeo ausente." });

    const videoResult = await streamUpload(req.files['video'][0].buffer, 'aura_posts', 'video');
    
    let thumbUrl = null;
    if (req.files['thumbnail']) {
      const thumbResult = await streamUpload(req.files['thumbnail'][0].buffer, 'aura_thumbs', 'image');
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
  } catch (err) { res.status(500).json({ error: "Falha no servidor" }); }
});

app.get('/posts', async (req, res) => {
  try {
    const { userId, userIdVisitado } = req.query; 
    const currentUserId = (userId && userId !== 'undefined') ? Number(userId) : 0;
    
    let query = db('posts')
      .join('users', 'posts.user_id', 'users.id')
      .select('posts.*', 'users.username', 'users.avatar_url', 'users.aura_color',
        db.raw('(SELECT COUNT(*) FROM likes WHERE post_id = posts.id) as likes_count'),
        db.raw(`EXISTS(SELECT 1 FROM likes WHERE post_id = posts.id AND user_id = ?) as user_liked`, [currentUserId])
      );

    if (userIdVisitado) query = query.where('posts.user_id', Number(userIdVisitado));

    const posts = await query.orderBy('posts.created_at', 'desc');
    res.json(posts);
  } catch (err) { res.status(500).json({ error: "Erro ao buscar posts." }); }
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
  } catch (err) { res.status(500).json({ error: "Erro no like." }); }
});

app.post('/posts/:id/comments', async (req, res) => {
  try {
    const { user_id, content } = req.body;
    const [newComment] = await db('comments').insert({ post_id: req.params.id, user_id, content }).returning('*');
    const full = await db('comments').join('users', 'comments.user_id', 'users.id').where('comments.id', newComment.id)
      .select('comments.*', 'users.username', 'users.avatar_url', 'users.aura_color').first();
    res.status(201).json(full);
  } catch (err) { res.status(500).json({ error: "Erro ao comentar." }); }
});

app.get('/posts/:id/comments', async (req, res) => {
  try {
    const comments = await db('comments').join('users', 'comments.user_id', 'users.id').where({ post_id: req.params.id })
      .select('comments.*', 'users.username', 'users.avatar_url', 'users.aura_color').orderBy('created_at', 'asc');
    res.json(comments);
  } catch (err) { res.status(500).json({ error: "Erro nos comentários." }); }
});

// --- INVENTÁRIO ---
app.get('/users/:id/inventory', async (req, res) => {
  try {
    const items = await db('user_inventory')
      .join('shop_items', 'user_inventory.item_id', 'shop_items.id')
      .where('user_inventory.user_id', req.params.id)
      .distinct('shop_items.id', 'shop_items.name', 'shop_items.item_value', 'shop_items.category', 'shop_items.image_url', 'shop_items.price')
      .select();
    res.json(items);
  } catch (err) { res.status(500).json({ error: "Erro ao buscar inventário" }); }
});

// --- SHOP ---
app.get('/shop', async (req, res) => {
  try { res.json(await db('shop_items').select('*')); } catch (err) { res.status(500).json({ error: "Erro loja." }); }
});

app.post('/shop/buy', async (req, res) => {
  try {
    const { userId, itemId } = req.body;
    await db.transaction(async (trx) => {
      const alreadyOwned = await trx('user_inventory').where({ user_id: userId, item_id: itemId }).first();
      if (alreadyOwned) throw new Error("Você já possui este item!");

      const item = await trx('shop_items').where({ id: itemId }).first();
      const user = await trx('users').where({ id: userId }).first();

      if (!item || !user) throw new Error("Não encontrado.");
      if (Number(user.balance) < Number(item.price)) throw new Error("Saldo insuficiente!");

      await trx('users').where({ id: userId }).update({ balance: Number(user.balance) - Number(item.price) });
      await trx('user_inventory').insert({ user_id: userId, item_id: itemId });
    });
    res.status(200).json({ success: true, message: "Compra realizada!" });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ROTA EQUIPAR
app.post('/users/equip-aura', async (req, res) => {
  const { userId, color } = req.body;
  try {
    // 1. Primeiro atualiza a cor
    await db('users').where({ id: Number(userId) }).update({ aura_color: color });

    // 2. BUSCA o usuário atualizado com o saldo REAL que está no banco
    const updatedUser = await db('users').where({ id: Number(userId) }).first();

    if (!updatedUser) return res.status(404).json({ error: "Não encontrado" });

    // 3. Retorna o usuário com o saldo que sobrou da compra
    return res.status(200).json({ success: true, user: updatedUser });
  } catch (err) { 
    res.status(500).json({ error: "Erro ao processar aura" }); 
  }
});

app.get('/', (req, res) => res.json({ status: "online", message: "🌌 Aura Santuário Ativo!" }));

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Porta ${PORT}`));