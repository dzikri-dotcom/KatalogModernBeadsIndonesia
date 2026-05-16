require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Groq = require('groq-sdk');

const RAGEngine = require('./lib/rag');
const DatasetManager = require('./lib/dataset');

const app = express();
const PORT = process.env.PORT || 3001;

// --- Middleware ---
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// --- Inisialisasi Engine ---
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

const ragEngine = new RAGEngine();
const datasetManager = new DatasetManager();

// --- State Management ---
let client = null;
let qrCodeData = null;
let isReady = false;
let isInitializing = false;
const handledMessageIds = new Set();

// --- File Configuration Paths ---
const knowledgeFile = path.join(__dirname, 'knowledge.json');
const behaviorFile = path.join(__dirname, 'config', 'behavior.json');

if (!fs.existsSync(knowledgeFile)) {
    fs.writeFileSync(
        knowledgeFile,
        JSON.stringify(
            {
                keywords: {},
                responses: {}
            },
            null,
            2
        )
    );
}

if (!fs.existsSync(path.dirname(behaviorFile))) {
    fs.mkdirSync(path.dirname(behaviorFile), {
        recursive: true
    });
}

// --- Helper Functions ---
const loadKnowledge = () => {
    try {
        return JSON.parse(fs.readFileSync(knowledgeFile, 'utf8'));
    } catch (error) {
        return {
            keywords: {},
            responses: {}
        };
    }
};

const saveKnowledge = data => {
    fs.writeFileSync(knowledgeFile, JSON.stringify(data, null, 2));

    if (ragEngine && typeof ragEngine.clearCache === 'function') {
        ragEngine.clearCache();
    }

    return true;
};

const loadBehavior = () => {
    try {
        if (!fs.existsSync(behaviorFile)) {
            return null;
        }

        return JSON.parse(fs.readFileSync(behaviorFile, 'utf8'));
    } catch (error) {
        return null;
    }
};

const saveBehavior = obj => {
    fs.writeFileSync(behaviorFile, JSON.stringify(obj, null, 2));
    return true;
};

// ======================================================
// HELPER CSV PRODUK
// ======================================================

function parseCsvLine(line) {
    const values = [];
    let current = '';
    let insideQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
            if (insideQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                insideQuotes = !insideQuotes;
            }

            continue;
        }

        if (char === ',' && !insideQuotes) {
            values.push(current.trim());
            current = '';
            continue;
        }

        current += char;
    }

    values.push(current.trim());

    return values;
}

function normalizeCategoryFromFile(fileName) {
    const rawName = fileName
        .replace('.csv', '')
        .replace('shopee_', '')
        .replace(/_/g, ' ')
        .toLowerCase();

    if (rawName.includes('diamond akrilik')) {
        return 'Diamond Akrilik';
    }

    if (rawName.includes('kristal ceko')) {
        return 'Kristal Ceko';
    }

    if (rawName.includes('manik kelopak bunga')) {
        return 'Manik Kelopak Bunga';
    }

    if (rawName.includes('berlian cangkang')) {
        return 'Berlian Cangkang';
    }

    if (rawName.includes('mutiara jepang')) {
        return 'Mutiara Jepang';
    }

    return rawName
        .split(' ')
        .filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function getWhatsappNumberByCategory(category) {
    const numbers = {
        'Diamond Akrilik': '6282141932384',
        'Kristal Ceko': '6281249779960',
        'Manik Kelopak Bunga': '6281266426445',
        'Berlian Cangkang': '6282143638682',
        'Mutiara Jepang': '6285708466400'
    };

    return numbers[category] || '6282141932384';
}

function formatPriceFromCsv(price) {
    if (!price) {
        return 'Harga cek via WhatsApp';
    }

    const clean = String(price).trim();

    if (clean.toLowerCase().includes('rp')) {
        return clean;
    }

    return `Rp ${clean}`;
}

function getProductsFromCsvFiles() {
    const dataDir = path.join(__dirname, 'data');

    if (!fs.existsSync(dataDir)) {
        return [];
    }

    const files = fs
        .readdirSync(dataDir)
        .filter(file => file.toLowerCase().endsWith('.csv'));

    const products = [];

    files.forEach(file => {
        const filePath = path.join(dataDir, file);
        const category = normalizeCategoryFromFile(file);
        const whatsappNumber = getWhatsappNumberByCategory(category);

        let content = fs.readFileSync(filePath, 'utf8');
        content = content.replace(/^\uFEFF/, '');

        const lines = content
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0);

        if (lines.length < 2) {
            return;
        }

        const headers = parseCsvLine(lines[0]);

        for (let i = 1; i < lines.length; i++) {
            const row = parseCsvLine(lines[i]);
            const rowObject = {};

            headers.forEach((header, index) => {
                rowObject[header] = row[index] || '';
            });

            const productName =
                rowObject['whitespace-normal'] ||
                rowObject['nama_produk'] ||
                rowObject['nama produk'] ||
                rowObject['name'] ||
                rowObject['title'] ||
                row[2] ||
                'Produk';

            const price =
                rowObject['font-medium 2'] ||
                rowObject['harga'] ||
                rowObject['price'] ||
                row[3] ||
                '';

            const image =
                rowObject['_image_yazkc_11 src'] ||
                rowObject['image'] ||
                rowObject['image_url'] ||
                rowObject['gambar'] ||
                row[1] ||
                '';

            const productLink =
                rowObject['contents href'] ||
                rowObject['link'] ||
                rowObject['url'] ||
                row[0] ||
                '';

            const rating =
                rowObject['inline-block'] ||
                rowObject['rating'] ||
                row[4] ||
                '';

            const sold =
                rowObject['truncate'] ||
                rowObject['terjual'] ||
                rowObject['sold'] ||
                row[5] ||
                '';

            const whatsappText = encodeURIComponent(
                `Halo admin, saya ingin bertanya tentang produk ${productName} kategori ${category}`
            );

            products.push({
                id: `${file}-${i}`,
                sourceFile: file,
                name: productName,
                category: category,
                price: formatPriceFromCsv(price),
                rawPrice: price,
                image: image,
                link: productLink,
                rating: rating,
                sold: sold,
                whatsappNumber: whatsappNumber,
                whatsappUrl: `https://wa.me/${whatsappNumber}?text=${whatsappText}`
            });
        }
    });

    return products;
}

// --- AI Core Logic ---
async function getAIResponse(message, contextItems = [], behavior = null) {
    try {
        const contextBlock = ragEngine.buildContextBlock(contextItems);

        if (!behavior) {
            behavior = loadBehavior() || {
                system_instructions: 'Jawab singkat sebagai admin toko.',
                fallback_response: 'Maaf, produk belum tersedia.',
                max_sentences: 2,
                language: 'id'
            };
        }

        if (!contextBlock || contextItems.length === 0) {
            return behavior.fallback_response;
        }

        const systemMessage = `${behavior.system_instructions} Jawab maksimal ${behavior.max_sentences} kalimat dalam Bahasa ${behavior.language}. Gunakan konteks yang diberikan.`;

        const completion = await groq.chat.completions.create({
            messages: [
                {
                    role: 'system',
                    content: systemMessage
                },
                {
                    role: 'user',
                    content: `Konteks:\n${contextBlock}\n\nPertanyaan: ${message}`
                }
            ],
            model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
            temperature: 0.1
        });

        return completion.choices[0].message.content;
    } catch (error) {
        console.error('AI Error:', error.message);
        return null;
    }
}

// --- WhatsApp Client ---
function initializeClient() {
    if (client) {
        return client;
    }

    client = new Client({
        authStrategy: new LocalAuth({
            clientId: 'whatsapp-bot'
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox'
            ]
        }
    });

    client.on('qr', qr => {
        qrCodeData = qr;
        console.log('📱 QR Code Generated');
        qrcode.generate(qr, {
            small: true
        });
    });

    client.on('ready', () => {
        console.log('✅ Bot is ready & Listening for Personal Chats!');
        isReady = true;
        isInitializing = false;
        qrCodeData = null;
    });

    client.on('authenticated', () => {
        console.log('🔐 WhatsApp authenticated');
    });

    client.on('auth_failure', msg => {
        console.log('❌ Auth failure:', msg);
        isReady = false;
        isInitializing = false;
        qrCodeData = null;
    });

    client.on('disconnected', reason => {
        console.log('⚠️ WhatsApp disconnected:', reason);
        client = null;
        isReady = false;
        isInitializing = false;
        qrCodeData = null;
    });

    client.on('message', handleIncomingMessage);

    return client;
}

async function handleIncomingMessage(msg) {
    try {
        // 1. FILTER: Abaikan jika dari grup
        if (msg.from && msg.from.includes('@g.us')) {
            return;
        }

        // 2. FILTER ANTI-LOOP
        if (msg.fromMe || msg.isStatus || (msg.from && msg.from.endsWith('@status'))) {
            return;
        }

        // 3. FILTER TIPE
        if (msg.type !== 'chat') {
            return;
        }

        // 4. Hindari duplikasi pesan
        const msgId = msg.id?._serialized;

        if (msgId) {
            if (handledMessageIds.has(msgId)) {
                return;
            }

            handledMessageIds.add(msgId);

            setTimeout(() => {
                handledMessageIds.delete(msgId);
            }, 300000);
        }

        console.log(`📩 Pesan Masuk Personal dari ${msg.from}: ${msg.body}`);

        const query = msg.body.toLowerCase().trim();
        const knowledge = loadKnowledge();

        // 5. Cek keyword manual
        if (knowledge.responses && knowledge.responses[query]) {
            await msg.reply(knowledge.responses[query]);
            return;
        }

        // 6. RAG Logic
        const allDocs = datasetManager.getAllDocuments();
        const context = ragEngine.retrieveContext(msg.body, allDocs, 3);
        const behavior = loadBehavior();

        const aiResponse = await getAIResponse(msg.body, context, behavior);

        if (aiResponse) {
            await msg.reply(aiResponse);
        }
    } catch (err) {
        console.error('Processing Error:', err);
    }
}

async function startBot() {
    if (isReady || isInitializing) {
        return {
            success: false,
            message: 'Bot sudah aktif'
        };
    }

    isInitializing = true;

    const instance = initializeClient();

    await instance.initialize();

    return {
        success: true,
        message: 'Bot memulai...'
    };
}

// --- API Endpoints ---

app.get('/api/status', (req, res) => {
    res.json({
        isReady,
        isInitializing,
        hasQRCode: !!qrCodeData
    });
});

app.get('/api/bot/status', (req, res) => {
    res.json({
        isReady,
        isInitializing,
        hasQRCode: !!qrCodeData
    });
});

app.get('/api/bot/qr', (req, res) => {
    res.json({
        qr: qrCodeData
    });
});

app.post('/api/bot/start', async (req, res) => {
    try {
        const result = await startBot();
        res.json(result);
    } catch (error) {
        console.error('Start bot error full:', error);
        console.error('Start bot error message:', error?.message);

        isInitializing = false;

        res.status(500).json({
            success: false,
            message: error?.message || String(error) || 'Gagal memulai bot'
        });
    }
});

app.post('/api/bot/stop', async (req, res) => {
    if (client) {
        try {
            await client.destroy();

            client = null;
            isReady = false;
            qrCodeData = null;
            isInitializing = false;

            console.log('🛑 Bot dihentikan');

            return res.json({
                success: true,
                message: 'Bot dihentikan'
            });
        } catch (err) {
            return res.status(500).json({
                success: false,
                message: err.message
            });
        }
    }

    res.json({
        success: false,
        message: 'Bot tidak aktif'
    });
});

// ======================================================
// API PRODUCTS FROM CSV
// ======================================================

app.get('/api/products', (req, res) => {
    try {
        const products = getProductsFromCsvFiles();

        const categories = [
            ...new Set(products.map(product => product.category))
        ];

        res.json({
            success: true,
            totalProducts: products.length,
            totalCategories: categories.length,
            categories: categories,
            products: products
        });
    } catch (error) {
        console.error('Error /api/products:', error.message);

        res.status(500).json({
            success: false,
            message: error.message,
            totalProducts: 0,
            totalCategories: 0,
            categories: [],
            products: []
        });
    }
});

// Endpoint Management Knowledge & Behavior
app.get('/api/knowledge/keywords', (req, res) => {
    res.json(loadKnowledge());
});

app.post('/api/knowledge/keyword', (req, res) => {
    const { keyword, response } = req.body;

    if (!keyword || !response) {
        return res.status(400).json({
            success: false,
            message: 'Keyword dan response wajib diisi'
        });
    }

    const knowledge = loadKnowledge();

    if (!knowledge.responses) {
        knowledge.responses = {};
    }

    knowledge.responses[keyword.toLowerCase().trim()] = response;

    saveKnowledge(knowledge);

    res.json({
        success: true
    });
});

app.get('/api/behavior', (req, res) => {
    res.json(loadBehavior() || {});
});

app.post('/api/behavior', (req, res) => {
    saveBehavior(req.body);

    res.json({
        success: true
    });
});

// Default route untuk welcome page
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);

    const products = getProductsFromCsvFiles();
    const categories = [
        ...new Set(products.map(product => product.category))
    ];

    console.log(`📦 Total produk dari CSV: ${products.length}`);
    console.log(`🏷️ Total kategori: ${categories.length}`);

    categories.forEach(category => {
        console.log(`✅ Kategori terbaca: ${category}`);
    });

    if (process.env.AUTO_START_BOT !== 'false') {
        startBot().catch(err => {
            console.error('Auto-start error:', err?.message || err);
            isInitializing = false;
        });
    }
});