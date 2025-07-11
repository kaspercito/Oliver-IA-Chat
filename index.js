require('dotenv').config();
const { Client, IntentsBitField } = require('discord.js');
const { manejarChat } = require('./commands/manejarChat');
const express = require('express');

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
  ],
});

const CHAT_CHANNEL_ID = '1343749554905940058';

// Servidor HTTP para Render
const app = express();
app.get('/ping', (req, res) => {
  console.log('Recibí un ping, ¡estoy vivo!');
  res.send('¡Bot awake y con pilas!');
});
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor de ping corriendo en el puerto ${PORT}`);
});

client.on('ready', () => {
  console.log(`Bot de chat conectado como ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || message.channel.id !== CHAT_CHANNEL_ID) return;
  if (message.content.startsWith('!chat') || message.content.startsWith('!ch')) {
    console.log('Llamando a manejarChat para el mensaje:', message.content);
    await manejarChat(message);
  }
});

client.login(process.env.DISCORD_TOKEN);
