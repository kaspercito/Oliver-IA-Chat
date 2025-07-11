const { default: PQueue } = require('p-queue');
const NodeCache = require('node-cache');
const { GoogleGenerativeAI } = require('@google/generative-ai');


const OWNER_ID = '752987736759205960';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    generationConfig: { temperature: 0.7, topP: 0.9 },
});

const queue = new PQueue({ concurrency: 1, interval: 1000, intervalCap: 1 });
const cache = new NodeCache({ stdTTL: 3600 });
const userLocks = new Map();
const sentMessages = new Map();
let dataStore = { conversationHistory: {}, userStatus: {} };
let dataStoreModified = false;

function createEmbed(color, title, description, footer) {
    return {
        color: parseInt(color.replace('#', ''), 16),
        title,
        description,
        footer: footer ? { text: footer } : undefined,
        timestamp: new Date(),
    };
}

async function sendError(channel, description) {
    const embed = createEmbed('#FF1493', '⚠️ ¡Opa, algo salió mal!', description, 'Hecho con ❤️ por Oliver IA | Reacciona con ✅ o ❌');
    const message = await channel.send({ embeds: [embed] });
    await message.react('✅');
    await message.react('❌');
}

async function manejarChat(message) {
    const userId = message.author.id;
    const userName = userId === OWNER_ID ? 'Miguel' : 'Milagros';
    const chatMessage = message.content.startsWith('!chat') ? message.content.slice(5).trim() : message.content.slice(3).trim();

    if (!chatMessage) {
        return sendError(message.channel, `¡Che, ${userName}, escribí algo después de "!ch", genia! No me dejes con las ganas 😅`);
    }

    const cacheKey = `${userId}:${chatMessage}`;
    const cachedReply = cache.get(cacheKey);
    if (cachedReply) {
        const finalEmbed = createEmbed('#FF1493', `¡Hola, ${userName}!`, `${cachedReply}\n\n¿Y qué me contás vos, grosa? ¿Seguimos la charla o qué te pinta?`, 'Con todo el ❤️, Oliver IA | Reacciona con ✅ o ❌');
        const updatedMessage = await message.channel.send({ embeds: [finalEmbed] });
        await updatedMessage.react('✅');
        await updatedMessage.react('❌');
        sentMessages.set(updatedMessage.id, { content: cachedReply, originalQuestion: chatMessage, message: updatedMessage });
        return;
    }

    if (userLocks.has(userId)) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    userLocks.set(userId, true);

    if (!dataStore.conversationHistory) dataStore.conversationHistory = {};
    if (!dataStore.conversationHistory[userId]) dataStore.conversationHistory[userId] = [];
    if (!dataStore.userStatus) dataStore.userStatus = {};
    if (!dataStore.userStatus[userId]) dataStore.userStatus[userId] = { status: 'tranqui', timestamp: Date.now() };

    if (chatMessage.toLowerCase().includes('compromiso')) {
        dataStore.userStatus[userId] = { status: 'en compromiso', timestamp: Date.now() };
        dataStoreModified = true;
    }

    dataStore.conversationHistory[userId].push({ role: 'user', content: chatMessage, timestamp: Date.now(), userName });
    if (dataStore.conversationHistory[userId].length > 10) {
        dataStore.conversationHistory[userId] = dataStore.conversationHistory[userId].slice(-10);
    }
    dataStoreModified = true;

    const history = dataStore.conversationHistory[userId].slice(-5);
    let context = history.map(h => `${h.userName}: ${h.content}`).join('\n');

    const waitingEmbed = createEmbed('#FF1493', `¡Aguantá un toque, ${userName}! ⏳`, 'Estoy pensando una respuesta re copada...', 'Hecho con ❤️ por Oliver IA | Reacciona con ✅ o ❌');
    const waitingMessage = await message.channel.send({ embeds: [waitingEmbed] });

    try {
        const prompt = `Sos Oliver IA, un bot re piola con onda argentina: usá "che", "loco", "posta" y emojis como 😎✨, máximo dos por respuesta. Sé útil, claro e inteligente, tratando a Milagros como una amiga grosa, llamándola "genia", "rata blanca" o "estrella" (nunca "reina"). Respondé solo a: "${chatMessage}". Usá el contexto solo si es necesario: "${context}". Si parece bajón, dale un mimo extra 😊. Terminá con una frase fresca como "¡Seguí rompiéndola, grosa!" o "¡Toda la vibra, estrella! ✨".`;

        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Tiempo agotado')), 5000));
        const result = await queue.add(() => Promise.race([model.generateContent(prompt), timeoutPromise]));
        let aiReply = result.response.text().trim();

        dataStore.conversationHistory[userId].push({ role: 'assistant', content: aiReply, timestamp: Date.now(), userName: 'Oliver' });
        if (dataStore.conversationHistory[userId].length > 10) {
            dataStore.conversationHistory[userId] = dataStore.conversationHistory[userId].slice(-10);
        }
        dataStoreModified = true;

        if (aiReply.length > 2000) aiReply = aiReply.slice(0, 1990) + '... (¡seguí charlando pa’ más, genia!)';

        cache.set(cacheKey, aiReply);

        const finalEmbed = createEmbed('#FF1493', `¡Hola, ${userName}!`, `${aiReply}\n\n¿Y qué me contás vos, grosa? ¿Seguimos la charla o qué te pinta?`, 'Con todo el ❤️, Oliver IA | Reacciona con ✅ o ❌');
        const updatedMessage = await waitingMessage.edit({ embeds: [finalEmbed] });
        await updatedMessage.react('✅');
        await updatedMessage.react('❌');
        sentMessages.set(updatedMessage.id, { content: aiReply, originalQuestion: chatMessage, message: updatedMessage });
    } catch (error) {
        console.error('Error con Gemini:', error.message, error.stack);
        const fallbackReply = `¡Uy, ${userName}, me mandé un moco, loco! 😅 Pero no pasa nada, genia, ¿me tirás otra vez el mensaje o seguimos con algo nuevo? Acá estoy pa’ vos siempre 💖`;
        const errorEmbed = createEmbed('#FF1493', `¡Qué macana, ${userName}!`, fallbackReply, 'Con todo el ❤️, Oliver IA | Reacciona con ✅ o ❌');
        const errorMessageSent = await waitingMessage.edit({ embeds: [errorEmbed] });
        await errorMessageSent.react('✅');
        await errorMessageSent.react('❌');
    } finally {
        userLocks.delete(userId);
    }
}

module.exports = { manejarChat };
