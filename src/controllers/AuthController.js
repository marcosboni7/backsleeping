// src/controllers/AuthController.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db'); // Sua conexão com Postgres

async function register(req, res) {
  const { username, email, password } = req.body;

  try {
    // 1. Criptografar a senha
    const hashedPassword = await bcrypt.hash(password, 10);

    // 2. Salvar no Postgres (Exemplo usando Knex)
    const newUser = await db('users').insert({
      username,
      email,
      password: hashedPassword,
      balance: 1000 // Começa com um bônus de cristais
    }).returning('*');

    res.status(201).json(newUser[0]);
  } catch (error) {
    res.status(400).json({ error: "Erro ao registrar usuário. Email já existe?" });
  }
}