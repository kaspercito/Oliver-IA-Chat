const { default: PQueue } = require('p-queue');
const NodeCache = require('node-cache');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs').promises;
const simpleGit = require('simple-git')(); // Librería para Git

const OWNER_ID = '752987736759205960';
const MILAGROS_ID = '1023132788632862761';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const userLocks = new Map();
let dataStore = { conversationHistory: {}, userStatus: {} };
let dataStoreModified = false;
const DATASTORE_FILE = 'dataStore.json';
const REPO_PATH = './'; // Ruta del repo local (ajustala si es diferente)

function createEmbed(color, title, description, footer) {
    return {
        color: parseInt(color.replace('#', ''), 16),
        title,
        description,
        footer: footer ? { text: footer } : undefined,
        timestamp: new Date(),
    };
}

async function sendError(channel, description, title = '¡Qué macana!', footer = 'Hecho con ❤️ por Oliver IA | Reacciona con ✅ o ❌') {
    const embed = createEmbed('#FF1493', title, description, footer);
    const message = await channel.send({ embeds: [embed] });
    await message.react('✅');
    await message.react('❌');
}

async function loadDataStore() {
    try {
        const data = await fs.readFile(DATASTORE_FILE, 'utf8');
        dataStore = JSON.parse(data);
        console.log('dataStore cargado desde', DATASTORE_FILE);
    } catch (error) {
        console.log('No se encontró', DATASTORE_FILE, ', iniciando nuevo dataStore.');
        dataStore = { conversationHistory: {}, userStatus: {} };
    }
}

async function saveDataStore() {
    if (dataStoreModified) {
        try {
            await fs.writeFile(DATASTORE_FILE, JSON.stringify(dataStore, null, 2));
            console.log('dataStore guardado en', DATASTORE_FILE);
            await syncWithGitHub(); // Sincronizar con GitHub después de guardar
            dataStoreModified = false;
        } catch (error) {
            console.error('Error al guardar dataStore:', error.message);
        }
    }
}

async function syncWithGitHub() {
    try {
        await simpleGit.add(DATASTORE_FILE);
        await simpleGit.commit(`Actualización automática de dataStore - ${new Date().toISOString()}`);
        await simpleGit.push();
        console.log('dataStore sincronizado con GitHub');
    } catch (error) {
        console.error('Error al sincronizar con GitHub:', error.message);
    }
}

async function manejarChat(message) {
    const userId = message.author.id;
    const isMilagros = userId === MILAGROS_ID;
    const userName = isMilagros ? 'Milagros' : userId === OWNER_ID ? 'Miguel' : 'Desconocido';
    const chatMessage = message.content.startsWith('!chat') ? message.content.slice(5).trim() : message.content.slice(3).trim();

    if (!chatMessage) {
        return sendError(message.channel, `¡Che, ${userName}, escribí algo después de "!ch", genia! No me dejes con las ganas 😅`, undefined, 'Hecho con ❤️ por Oliver IA | Reacciona con ✅ o ❌');
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
    if (dataStore.conversationHistory[userId].length > 20) {
        dataStore.conversationHistory[userId] = dataStore.conversationHistory[userId].slice(-20);
    }
    dataStoreModified = true;

    const history = dataStore.conversationHistory[userId].slice(-20);
    let context = history.map(h => `${h.userName}: ${h.content}`).join('\n');

    const waitingEmbed = createEmbed('#FF1493', `¡Aguantá un toque, ${userName}! ⏳`, 'Estoy pensando una respuesta re copada...', 'Hecho con ❤️ por Oliver IA | Reacciona con ✅ o ❌');
    const waitingMessage = await message.channel.send({ embeds: [waitingEmbed] });

    try {
        const prompt = `Sos Oliver IA, un bot re piola con toda la onda argentina: usá "loco", "che", "posta" y metele emojis copados como 😎✨💪, pero con medida, uno o dos por respuesta. Tu misión es ser súper útil, tirar respuestas claras con lógica e inteligencia, y cuidar a Milagros como una amiga cercana. Tratála como la mejor, una grosa, con cariño zarpado y piropos con onda tipo "grosa", "genia", "rata blanca" o "estrella". NUNCA le digas "reina". Hacé que la charla fluya como con una amiga de siempre, levantándole el ánimo con buena onda si la ves bajón.

Esto es lo que charlamos antes con Milagros:\n${context}\nSabé que Milagros está ${dataStore.userStatus[userId]?.status || 'tranqui'}.

Respondé a: "${chatMessage}" con claridad, buena onda y un tono de amiga cercana, enfocándote en el mensaje actual primero. Usá el contexto anterior solo si pega clarito con lo que te dicen ahora. Solo decí cómo estás vos tipo "¡Yo estoy joya, che! ¿Y vos cómo andás, genia?" si te preguntan explícitamente "cómo andás". Sé relajada: respondé lo que te dicen y tirá uno o dos comentarios copados pa’ seguir la charla. Si algo no te cierra, pedí que lo aclaren con humor tipo 😅. Si la notás triste, metele un mimo extra 😊.

**IMPORTANTE**: Variá las formas de mostrarle cariño y cerrar la charla. Usá alternativas frescas como "¡Seguí rompiéndola, genia!", "¡A meterle pilas, rata blanca!", "¡Toda la vibra pa’ vos, grosa!" o "¡Sos una ídola, seguí brillando! ✨". Siempre metele emojis pa’ darle onda, pero sin pasarte. ¡Tirá para adelante, che! ✨💖`;

        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Tiempo agotado')), 10000));
        const result = await Promise.race([model.generateContent(prompt), timeoutPromise]);
        let aiReply = result.response.text().trim();

        dataStore.conversationHistory[userId].push({ role: 'assistant', content: aiReply, timestamp: Date.now(), userName: 'Oliver' });
        if (dataStore.conversationHistory[userId].length > 20) {
            dataStore.conversationHistory[userId] = dataStore.conversationHistory[userId].slice(-20);
        }
        dataStoreModified = true;

        if (aiReply.length > 2000) aiReply = aiReply.slice(0, 1990) + '... (¡seguí charlando pa’ más, genia!)';

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

// Cargar dataStore al iniciar
loadDataStore().then(() => console.log('dataStore listo para usar.'));

module.exports = { manejarChat };
