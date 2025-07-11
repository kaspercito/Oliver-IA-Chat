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
app.get('/health', (req, res) => res.send('OK'));
app.listen(process.env.PORT || 10000, () => console.log('Health endpoint running on port', process.env.PORT || 10000));

client.on('ready', () => {
    console.log(`Bot de chat conectado como ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || message.channel.id !== CHAT_CHANNEL_ID) return;
    if (message.content.startsWith('!chat') || message.content.startsWith('!ch')) {
        await manejarChat(message);
    }
});

client.login(process.env.DISCORD_TOKEN);
