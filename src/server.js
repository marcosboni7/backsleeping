const express = require('express');
const cors = require('cors');
const db = require('./config/db'); 
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer'); 
const path = require('path');    
const fs = require('fs');        
const http = require('http'); 
const { Server } = require('socket.io'); 

const app = express();
const server = http.createServer(app); 
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- AJUSTE PARA DEPLOY (RENDER) ---
const PORT = process.env.PORT || 3333; 
const JWT_SECRET = process.env.JWT_SECRET || 'minha_chave_galatica_secreta';

// --- CONFIGURAÇÃO DE LIMITES E MIDDLEWARES ---
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// --- CONFIGURAÇÃO DO MULTER (ARMAZENAMENTO LOCAL TEMPORÁRIO) ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});

const upload = multer({ 
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } 
});

const uploadFields = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
  { name: 'avatar', maxCount: 1 }
]);

app.use('/uploads', express.static(uploadDir));

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
      console.log("Erro ao carregar histórico:", err.message);
    }
  });

  socket.on('send_message', async (data) => {
    try {
      // Busca dados atualizados do usuário para o chat
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

      // Salva no banco
      const [insertedMsg] = await db('messages').insert(messageToSave).returning('*');

      // Envia para todos na sala
      io.to(data.room).emit('receive_message', insertedMsg);

    } catch (err) {
      console.error("❌ Erro ao salvar mensagem:", err.message);
    }
  });

  socket.on('disconnect', () => console.log('👤 Viajante saiu.'));
});

// --- ROTA DE TESTE ---
app.get('/', (req, res) => {
  res.send('🌌 Santuário Aura Online e Operante!');
});

// --- AUTENTICAÇÃO ---
app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const [newUser] = await db('users').insert({
      username,
      email,
      password: hashedPassword,
      balance: 1000,
      role: 'user',
      xp: 0,
      aura_color: '#ffffff'
    }).returning('*');
    
    res.status(201).json({ 
      message: "Usuário criado!", 
      user: { id: newUser.id, username: newUser.username } 
    });
  } catch (err) {
    res.status(400).json({ error: "Erro ao registrar. Email já existe?" });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await db('users').where({ email }).first();
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) return res.status(401).json({ error: "Senha incorreta" });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({
      token,
      user: { 
        id: user.id, 
        username: user.username, 
        balance: user.balance,
        role: user.role,
        xp: user.xp || 0,
        bio: user.bio || '',
        avatar_url: user.avatar_url || null,
        aura_color: user.aura_color
      }
    });
  } catch (err) {
    res.status(500).json({ error: "Erro no servidor" });
  }
});

// --- COMENTÁRIOS (ADICIONADO PARA CORRIGIR O ERRO JSON) ---
app.post('/posts/:id/comments', async (req, res) => {
  const post_id = parseInt(req.params.id);
  const user_id = parseInt(req.body.user_id);
  const { content } = req.body;

  // VERIFICAÇÃO DE SEGURANÇA: Se algum ID for NaN, ele avisa o App
  if (isNaN(post_id) || isNaN(user_id)) {
    console.error(`❌ Erro de Dados: PostID=${req.params.id}, UserID=${req.body.user_id}`);
    return res.status(400).json({ 
      error: "ID do post ou do usuário inválido (NaN). Verifique se o usuário está logado." 
    });
  }

  if (!content || content.trim() === '') {
    return res.status(400).json({ error: "O comentário não pode estar vazio." });
  }

  try {
    const [newComment] = await db('comments').insert({
      post_id: post_id,
      user_id: user_id,
      content: content
    }).returning('*');
    
    const commentWithUser = await db('comments')
      .join('users', 'comments.user_id', 'users.id')
      .where('comments.id', newComment.id)
      .select('comments.*', 'users.username', 'users.avatar_url', 'users.aura_color')
      .first();

    res.status(201).json(commentWithUser);
  } catch (err) {
    console.error("❌ Erro no Banco:", err.message);
    res.status(500).json({ error: "Erro ao salvar no banco de dados." });
  }
});

app.get('/posts/:id/comments', async (req, res) => {
  try {
    const comments = await db('comments')
      .join('users', 'comments.user_id', 'users.id')
      .where({ post_id: Number(req.params.id) })
      .select('comments.*', 'users.username', 'users.avatar_url', 'users.aura_color')
      .orderBy('created_at', 'asc');
    res.json(comments);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar comentários" });
  }
});

// --- PERFIL E USUÁRIOS ---
app.get('/users/:id/profile', async (req, res) => {
  const targetId = Number(req.params.id);
  const currentUserId = Number(req.query.currentUserId);
  try {
    const user = await db('users').where({ id: targetId }).select('id', 'username', 'balance', 'bio', 'avatar_url', 'role', 'xp', 'aura_color').first();
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    
    const followersCount = await db('follows').where({ following_id: targetId }).count('id as count').first();
    const followingCount = await db('follows').where({ follower_id: targetId }).count('id as count').first();
    
    let isFollowing = false;
    if (currentUserId) {
        const followCheck = await db('follows').where({ follower_id: currentUserId, following_id: targetId }).first();
        isFollowing = !!followCheck;
    }
    res.json({ ...user, followers: parseInt(followersCount?.count || 0), following: parseInt(followingCount?.count || 0), isFollowing });
  } catch (err) { res.status(500).json({ error: "Erro ao buscar perfil" }); }
});

app.put('/users/:id', uploadFields, async (req, res) => {
  const { id } = req.params;
  const { username, bio } = req.body;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const baseUrl = `${protocol}://${host}`;

  try {
    const dataToUpdate = { username, bio };
    if (req.files && req.files['avatar']) {
      dataToUpdate.avatar_url = `${baseUrl}/uploads/${req.files['avatar'][0].filename}`;
    }
    const [updatedUser] = await db('users').where({ id }).update(dataToUpdate).returning('*');
    res.json({ message: "Sua essência foi atualizada!", user: updatedUser });
  } catch (err) { res.status(500).json({ error: "Falha ao atualizar perfil." }); }
});

// --- POSTS ---
app.post('/posts/upload', uploadFields, async (req, res) => {
  const { userId, title, description } = req.body;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const baseUrl = `${protocol}://${host}`;

  try {
    const videoFile = req.files['video'] ? req.files['video'][0] : null;
    const thumbFile = req.files['thumbnail'] ? req.files['thumbnail'][0] : null;
    
    if (!videoFile) return res.status(400).json({ error: "O vídeo é obrigatório." });

    const [newPost] = await db('posts').insert({
      user_id: userId, 
      title: title || 'Nova Essência', 
      description: description || '',
      media_url: `${baseUrl}/uploads/${videoFile.filename}`,
      thumbnail_url: thumbFile ? `${baseUrl}/uploads/${thumbFile.filename}` : null,
      type: 'video'
    }).returning('*');
    
    res.status(201).json(newPost);
  } catch (err) { 
    console.error("ERRO NO UPLOAD:", err);
    res.status(500).json({ error: "Falha ao publicar" }); 
  }
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
    if (userIdVisitado && userIdVisitado !== 'undefined') query = query.where('posts.user_id', Number(userIdVisitado));
    const posts = await query.orderBy('posts.created_at', 'desc');
    res.json(posts);
  } catch (err) { res.status(500).json({ error: "Erro ao buscar posts" }); }
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
    } catch (err) { res.status(500).json({ error: "Erro nos likes" }); }
});

// --- LOJA ---
app.get('/shop', async (req, res) => {
  try {
    const items = await db('shop_items').select('*');
    res.json(items);
  } catch (err) { res.status(500).json({ error: "Erro ao carregar loja" }); }
});

app.post('/shop/buy', async (req, res) => {
  const { userId, itemId } = req.body;
  try {
    await db.transaction(async (trx) => {
      const item = await trx('shop_items').where({ id: itemId }).first();
      const user = await trx('users').where({ id: userId }).first();

      if (!user || !item) throw new Error("Usuário ou Item não encontrado");
      if (user.balance < item.price) throw new Error("Saldo insuficiente!");

      const [updatedUser] = await trx('users').where({ id: userId }).decrement('balance', item.price).returning('*');

      await trx('transactions').insert({
        user_id: userId, value: -item.price, gift_name: `🛒 Compra: ${item.name}`
      });

      await trx('user_inventory').insert({ user_id: userId, item_id: itemId });

      if (item.category === 'aura') {
        await trx('users').where({ id: userId }).update({ aura_color: item.item_value });
      }

      res.json({ success: true, message: `Você adquiriu ${item.name}!`, newBalance: updatedUser.balance });
    });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// --- INICIALIZAÇÃO ---
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AURA BACK-END ONLINE NA PORTA ${PORT}`);
});