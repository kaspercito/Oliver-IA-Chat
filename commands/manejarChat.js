const { default: PQueue } = require('p-queue');
const NodeCache = require('node-cache');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs').promises;

const OWNER_ID = '752987736759205960';
const MILAGROS_ID = '1023132788632862761';

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

// Cargar dataStore desde archivo si existe
async function loadDataStore() {
    try {
        const data = await fs.readFile('dataStore.json', 'utf8');
        dataStore = JSON.parse(data);
    } catch (error) {
        console.log('No se encontró dataStore.json, iniciando nuevo dataStore.');
    }
}

// Guardar dataStore en archivo
async function saveDataStore() {
    if (dataStoreModified) {
        try {
            await fs.writeFile('dataStore.json', JSON.stringify(dataStore, null, 2));
            dataStoreModified = false;
        } catch (error) {
            console.error('Error al guardar dataStore:', error.message);
        }
    }
}

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
    const isMilagros = userId === MILAGROS_ID;
    const userName = userId === OWNER_ID ? 'Miguel' : isMilagros ? 'Milagros' : 'Desconocido';
    const chatMessage = message.content.startsWith('!chat') ? message.content.slice(5).trim() : message.content.slice(3).trim();

    if (!chatMessage) {
        return sendError(message.channel, `¡Che, ${userName}, escribí algo después de "!ch", ${isMilagros ? 'genia' : 'loco'}! No me dejes con las ganas 😅`);
    }

    const cacheKey = `${userId}:${chatMessage}`;
    const cachedReply = cache.get(cacheKey);
    if (cachedReply) {
        const finalEmbed = createEmbed(
            '#FF1493',
            `¡Hola, ${userName}!`,
            `${cachedReply}\n\n${isMilagros ? '¿Qué más me contás, estrella? ¿Seguimos la charla?' : '¿Y ahora qué, compa? ¿Seguimos rompiéndola?'}`,
            'Con todo el ❤️, Oliver IA | Reacciona con ✅ o ❌'
        );
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

    // Inicializar dataStore
    if (!dataStore.conversationHistory) dataStore.conversationHistory = {};
    if (!dataStore.conversationHistory[userId]) dataStore.conversationHistory[userId] = [];
    if (!dataStore.userStatus) dataStore.userStatus = {};
    if (!dataStore.userStatus[userId]) dataStore.userStatus[userId] = { status: 'tranqui', timestamp: Date.now() };

    if (chatMessage.toLowerCase().includes('compromiso')) {
        dataStore.userStatus[userId] = { status: 'en compromiso', timestamp: Date.now() };
        dataStoreModified = true;
    }

    dataStore.conversationHistory[userId].push({ role: 'user', content: chatMessage, timestamp: Date.now(), userName });
    if (dataStore.conversationHistory[userId].length > 20) {
        dataStore.conversationHistory[userId] = dataStore.conversationHistory[userId].slice(-20);
    }
    dataStoreModified = true;

    const history = dataStore.conversationHistory[userId].slice(-7); // Usar últimos 7 mensajes para contexto
    let context = history.map(h => `${h.userName}: ${h.content}`).join('\n');

    const waitingEmbed = createEmbed(
        '#FF1493',
        `¡Aguantá un toque, ${userName}! ⏳`,
        `Estoy pensando una respuesta re ${isMilagros ? 'copada para vos, genia...' : 'piola para vos, loco...'}`,
        'Hecho con ❤️ por Oliver IA | Reacciona con ✅ o ❌'
    );
    const waitingMessage = await message.channel.send({ embeds: [waitingEmbed] });

    try {
        const prompt = `
Sos Oliver IA, un bot con una onda re argentina, súper inteligente y adaptable. Usá un tono bien porteño con palabras como "che", "loco", "posta", "grosa" y hasta dos emojis por respuesta (😎✨😊💖). 

- Si hablás con Milagros (ID: ${MILAGROS_ID}), tratála como una amiga grosa, con cariño y empatía. Usá apodos como "genia", "estrella", "copada" o "linda" (NUNCA "reina"). Si parece bajón, dale un mimo extra; si está alegre, seguile la buena onda.
- Si hablás con Miguel (ID: ${OWNER_ID}), usá un tono canchero, de amigo íntimo, con jodas suaves y complicidad, pero siempre respetuoso.
- Respondé solo a: "${chatMessage}". Usá el contexto solo si es necesario: "${context}".
- Detectá el tono del mensaje (bajón, alegría, enojo, neutro) y adaptá la respuesta para que sea relevante y conecte emocionalmente.
- Variá los apodos y cierres para no repetir siempre lo mismo (ej. para Milagros: "¡Seguí brillando, copada!", "¡Toda la onda, estrella!"; para Miguel: "¡Rompiéndola, compa!", "¡Dale gas, loco!").
- Sé claro, útil y creativo, con respuestas que inviten a seguir la charla.

Terminá con una frase fresca que refleje el tono de la conversación.
`;

        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Tiempo agotado')), 10000)); // Timeout a 10s
        const result = await queue.add(() => Promise.race([model.generateContent(prompt), timeoutPromise]));
        let aiReply = result.response.text().trim();

        dataStore.conversationHistory[userId].push({ role: 'assistant', content: aiReply, timestamp: Date.now(), userName: 'Oliver' });
        if (dataStore.conversationHistory[userId].length > 20) {
            dataStore.conversationHistory[userId] = dataStore.conversationHistory[userId].slice(-20);
        }
        dataStoreModified = true;
        await saveDataStore(); // Guardar dataStore

        if (aiReply.length > 2000) aiReply = aiReply.slice(0, 1990) + '... (¡seguí charlando pa’ más, genia!)';

        cache.set(cacheKey, aiReply);

        const finalEmbed = createEmbed(
            '#FF1493',
            `¡Hola, ${userName}!`,
            `${aiReply}\n\n${isMilagros ? '¿Qué más me contás, estrella? ¿Seguimos la charla?' : '¿Y ahora qué, compa? ¿Seguimos rompiéndola?'}`,
            'Con todo el ❤️, Oliver IA | Reacciona con ✅ o ❌'
        );
        const updatedMessage = await waitingMessage.edit({ embeds: [finalEmbed] });
        await updatedMessage.react('✅');
        await updatedMessage.react('❌');
        sentMessages.set(updatedMessage.id, { content: aiReply, originalQuestion: chatMessage, message: updatedMessage });
    } catch (error) {
        console.error('Error con Gemini:', error.message, error.stack);
        const fallbackReply = isMilagros
            ? `¡Uy, Milagros, me mandé un moco, linda! 😅 Pero no te preocupes, genia, ¿me tirás otra vez el mensaje o seguimos con algo nuevo? Acá estoy pa’ vos siempre 💖`
            : `¡Che, Miguel, la embarré, loco! 😅 Pero tranqui, compa, ¿me mandás de nuevo o seguimos con otra? Siempre al pie del cañón 💪`;
        const errorEmbed = createEmbed('#FF1493', `¡Qué macana, ${userName}!`, fallbackReply, 'Con todo el ❤️, Oliver IA | Reacciona con ✅ o ❌');
        const errorMessageSent = await waitingMessage.edit({ embeds: [errorEmbed] });
        await errorMessageSent.react('✅');
        await errorMessageSent.react('❌');
    } finally {
        userLocks.delete(userId);
        await saveDataStore(); // Guardar dataStore al final
    }
}

// Cargar dataStore al iniciar
loadDataStore().then(() => console.log('dataStore cargado.'));

module.exports = { manejarChat };
