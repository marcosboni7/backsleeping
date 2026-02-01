const knex = require('knex');

const db = knex({
  client: 'pg',
  connection: {
    host: '127.0.0.1',
    user: 'postgres',      // Usuário padrão do Postgres (confirme se é o seu)
    password: 'admin',     // Sua senha
    database: 'sleeping',  // Seu banco
  },
});

module.exports = db;