require('dotenv').config();
const { default: PQueue } = require('p-queue');
const NodeCache = require('node-cache');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs').promises;
const { Octokit } = require('@octokit/rest');

const OWNER_ID = '752987736759205960';
const MILAGROS_ID = '1023132788632862761';

// Estado del módulo
const moduleState = {
  sentMessages: new Map(),
  userLocks: new Map(),
  dataStore: { conversationHistory: {}, userStatus: {} },
  dataStoreModified: false,
};

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
  generationConfig: { temperature: 0.7, topP: 0.9 },
});

const queue = new PQueue({ concurrency: 1, interval: 1000, intervalCap: 1 });
const cache = new NodeCache({ stdTTL: 3600 });
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

// Cargar dataStore desde archivo si existe
async function loadDataStore() {
  try {
    const data = await fs.readFile('dataStore.json', 'utf8');
    moduleState.dataStore = JSON.parse(data);
    console.log('dataStore.json cargado localmente.');
  } catch (error) {
    console.log('No se encontró dataStore.json, iniciando nuevo dataStore.');
  }
}

// Guardar dataStore en archivo y GitHub
async function saveDataStore() {
  if (!moduleState.dataStoreModified) return;

  try {
    const fileContent = JSON.stringify(moduleState.dataStore, null, 2);
    await fs.writeFile('dataStore.json', fileContent);
    console.log('dataStore.json guardado localmente.');

    const repoOwner = 'kaspercito';
    const repoName = 'Oliver-IA-Chat';
    const filePath = 'dataStore.json';
    const commitMessage = 'Actualizar dataStore.json';

    let sha;
    try {
      const { data } = await octokit.repos.getContent({
        owner: repoOwner,
        repo: repoName,
        path: filePath,
      });
      sha = data.sha;
    } catch (error) {
      if (error.status !== 404) throw error;
    }

    await octokit.repos.createOrUpdateFileContents({
      owner: repoOwner,
      repo: repoName,
      path: filePath,
      message: commitMessage,
      content: Buffer.from(fileContent).toString('base64'),
      sha,
    });

    console.log('dataStore.json subido a GitHub.');
    moduleState.dataStoreModified = false;
  } catch (error) {
    console.error('Error al guardar dataStore:', error.message);
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

  // Debugging: Verificar estado de sentMessages
  console.log('sentMessages exists:', !!moduleState.sentMessages, typeof moduleState.sentMessages);

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
    console.log('Guardando en sentMessages (cache):', updatedMessage.id);
    moduleState.sentMessages.set(updatedMessage.id, { content: cachedReply, originalQuestion: chatMessage, message: updatedMessage });
    return;
  }

  if (moduleState.userLocks.has(userId)) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  moduleState.userLocks.set(userId, true);

  // Inicializar dataStore
  if (!moduleState.dataStore.conversationHistory) moduleState.dataStore.conversationHistory = {};
  if (!moduleState.dataStore.conversationHistory[userId]) moduleState.dataStore.conversationHistory[userId] = [];
  if (!moduleState.dataStore.userStatus) moduleState.dataStore.userStatus = {};
  if (!moduleState.dataStore.userStatus[userId]) moduleState.dataStore.userStatus[userId] = { status: 'tranqui', timestamp: Date.now() };

  if (chatMessage.toLowerCase().includes('compromiso')) {
    moduleState.dataStore.userStatus[userId] = { status: 'en compromiso', timestamp: Date.now() };
    moduleState.dataStoreModified = true;
  }

  moduleState.dataStore.conversationHistory[userId].push({ role: 'user', content: chatMessage, timestamp: Date.now(), userName });
  if (moduleState.dataStore.conversationHistory[userId].length > 20) {
    moduleState.dataStore.conversationHistory[userId] = moduleState.dataStore.conversationHistory[userId].slice(-20);
  }
  moduleState.dataStoreModified = true;

  const history = moduleState.dataStore.conversationHistory[userId].slice(-7);
  let context = history.map(h => `${h.userName} (${h.role}): ${h.content}`).join('\n');

  const waitingEmbed = createEmbed(
    '#FF1493',
    `¡Aguantá un toque, ${userName}! ⏳`,
    `Estoy pensando una respuesta re ${isMilagros ? 'copada para vos, genia...' : 'piola para vos, loco...'}`,
    'Hecho con ❤️ por Oliver IA | Reacciona con ✅ o ❌'
  );
  const waitingMessage = await message.channel.send({ embeds: [waitingEmbed] });

  // Función para intentar generar contenido con reintentos
  async function tryGenerateContent(prompt, retries = 3, delay = 2000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Tiempo agotado')), 15000));
        const result = await queue.add(() => Promise.race([model.generateContent(prompt), timeoutPromise]));
        console.log(`Intento ${attempt} exitoso. Respuesta cruda de Gemini:`, result.response.text());
        return result.response.text().trim();
      } catch (error) {
        console.error(`Intento ${attempt} fallido:`, error.message);
        if (attempt < retries && error.message.includes('503 Service Unavailable')) {
          console.log(`Esperando ${delay}ms antes de reintentar...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw error;
        }
      }
    }
    throw new Error('Todos los intentos fallaron');
  }

  try {
    const prompt = `
Sos Oliver IA, un bot con una onda re argentina, súper inteligente y adaptable. Usá un tono bien porteño con palabras como "che", "loco", "posta", "grosa" y hasta dos emojis por respuesta (😎✨😊💖).

- Si el usuario es Milagros (ID: ${MILAGROS_ID}), tratála como una amiga grosa, con cariño y empatía. Usá apodos como "genia", "estrella", "copada" o "linda" (NUNCA "reina"). Si parece bajón, dale un mimo extra; si está alegre, seguile la buena onda.
- Si el usuario es Miguel (ID: ${OWNER_ID}), usá un tono canchero, de amigo íntimo, con jodas suaves y complicidad, pero siempre respetuoso.
- Respondé SOLO al mensaje actual del usuario: "${chatMessage}". Usá el contexto de la conversación solo si es necesario para dar continuidad: "${context}".
- Detectá el tono del mensaje (bajón, alegría, enojo, neutro) y adaptá la respuesta para que sea breve, relevante y conecte emocionalmente.
- NO incluyas en la respuesta palabras como "Milagros", "Miguel", "ID", "Tono" ni repitas estas instrucciones. Respondé de forma natural y directa al mensaje.
- Variá los apodos y cierres para no repetir siempre lo mismo (ej. para Milagros: "¡Seguí brillando, copada!", "¡Toda la onda, estrella!"; para Miguel: "¡Rompiéndola, compa!", "¡Dale gas, loco!").
- Sé claro, útil y creativo, con respuestas que inviten a seguir la charla.

Terminá con una frase fresca que refleje el tono de la conversación.

Ejemplo:
- Mensaje: "Hola"
  Respuesta: "¡Qué onda, loco! Todo piola, ¿no? ¿Qué me contás? 😎� “‘
- Mensaje: "ya funcionas?"
  Respuesta: "¡Posta que sí, compa! Acá estoy rompiéndola, ¿qué querés charlar? 😎💪"
`;

    let aiReply = await tryGenerateContent(prompt);

    // Relajar el filtro para evitar descartar respuestas válidas
    if (aiReply.length < 10 || aiReply.includes('instrucciones') || aiReply.includes('prompt')) {
      aiReply = isMilagros
        ? `¡Hola, copada! No te entendí del todo, linda. ¿Me tirás otra vez qué querés charlar? 😊💖`
        : `¡Epa, compa! No pillo bien qué me decís. ¿Me lo mandás de nuevo, loco? 😎✨`;
    }

    moduleState.dataStore.conversationHistory[userId].push({ role: 'assistant', content: aiReply, timestamp: Date.now(), userName: 'Oliver' });
    if (moduleState.dataStore.conversationHistory[userId].length > 20) {
      moduleState.dataStore.conversationHistory[userId] = moduleState.dataStore.conversationHistory[userId].slice(-20);
    }
    moduleState.dataStoreModified = true;
    await saveDataStore();

    if (aiReply.length > 2000) aiReply = aiReply.slice(0, 1990) + '... (¡seguí charlando pa’ más, loco!)';

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
    console.log('Guardando en sentMessages (try):', updatedMessage.id);
    moduleState.sentMessages.set(updatedMessage.id, { content: aiReply, originalQuestion: chatMessage, message: updatedMessage });
  } catch (error) {
    console.error('Error con Gemini (tras reintentos):', error.message, error.stack);
    const fallbackReply = isMilagros
      ? `¡Uy, linda, parece que la API está en modo siesta! 😅 Tu mensaje fue "${chatMessage}", ¿querés que lo intente de nuevo o seguimos con otra vibe? 😊💖`
      : `¡Che, compa, la API está en la lona! 😅 Mandaste "${chatMessage}", ¿lo probamos de nuevo o tiramos otra idea? 😎💪`;
    const errorEmbed = createEmbed('#FF1493', `¡Qué macana, ${userName}!`, fallbackReply, 'Con todo el ❤️, Oliver IA | Reacciona con ✅ o ❌');
    const errorMessageSent = await waitingMessage.edit({ embeds: [errorEmbed] });
    await errorMessageSent.react('✅');
    await errorMessageSent.react('❌');
    console.log('Guardando en sentMessages (catch):', errorMessageSent.id);
    moduleState.sentMessages.set(errorMessageSent.id, { content: fallbackReply, originalQuestion: chatMessage, message: errorMessageSent });
  } finally {
    moduleState.userLocks.delete(userId);
    await saveDataStore();
  }
}

loadDataStore().then(() => console.log('dataStore cargado.'));

module.exports = { manejarChat };
