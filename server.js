// server.js - 赛博朋克版完美后台 (自动修复路径 + 爬虫)
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const fs = require('fs'); // 引入文件系统模块
const { v4: uuidv4 } = require('uuid');

// --- 爬虫需要的库 ---
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

const PORT = 3000;

// ============ 📂 1. 核心修复：智能路径配置 ============
// 不再硬编码 /www/wwwroot...，而是自动获取当前文件所在目录
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// 启动时检查 uploads 文件夹是否存在，没有就自动创建
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR);
    console.log(`📁 检测到文件夹缺失，已自动创建: ${UPLOAD_DIR}`);
} else {
    console.log(`📁 图片存储路径已锁定: ${UPLOAD_DIR}`);
}

// ============ 💾 2. 数据库配置 ============
const dbConfig = {
    host: '127.0.0.1', 
    user: 'heikeji_db', 
    password: 'tAGDB5zmYy2LJhGJ', 
    database: 'heikeji_db', 
    waitForConnections: true, 
    connectionLimit: 10, 
    queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

// ============ 📤 3. 上传配置 ============
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // 存到我们刚才定义的智能路径里
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        // 生成唯一文件名，防止图片重名覆盖
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

const app = express();
app.use(cors());

// 🔥 关键一行：让 /uploads 路径对应到硬盘上的文件夹
app.use('/uploads', express.static(UPLOAD_DIR));

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// ==========================================
// 🕸️ 爬虫核心逻辑
// ==========================================
const TARGET_URL = 'https://www.waihui999.com/cnymmk/#1';
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function runScraper() {
    console.log(`🕷️ [爬虫] 正在同步市场汇率... ${new Date().toLocaleTimeString()}`);
    try {
        const response = await axios.get(TARGET_URL, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36' },
            timeout: 10000,
            httpsAgent: httpsAgent
        });
        
        const $ = cheerio.load(response.data);
        let rateText = $('#toCost').text().trim(); 
        
        rateText = rateText.replace(/[^\d.]/g, '');
        let newRate = parseFloat(rateText);

        if (!isNaN(newRate) && newRate > 0) {
            if (newRate > 1000) newRate = newRate / 100;
            newRate = parseFloat(newRate.toFixed(4));

            await pool.execute('UPDATE exchange_rates SET rate = ?, updated_at = NOW() WHERE id = 1', [newRate]);
            console.log(`✅ [同步成功] 最新汇率: 1 RMB = ${newRate} MMK`);
        } 
    } catch (error) {
        console.error(`❌ [爬虫重试] 网络波动: ${error.message}`);
    }
}

// ==========================================
// 🚀 API 接口区域
// ==========================================

// 1. 创建商品 (图片路径存入数据库)
app.post('/api/products', upload.single('image'), async (req, res) => {
    try {
        const { cost, margin, weight, shiprate, optionalRate } = req.body;
        
        // 生成相对路径存入数据库 (例如: /uploads/1739999.jpg)
        let imagePath = '';
        if (req.file) {
            imagePath = '/uploads/' + req.file.filename;
        }

        const productUuid = uuidv4();
        let manualRateValue = (optionalRate && !isNaN(parseFloat(optionalRate)) && parseFloat(optionalRate) > 0) ? parseFloat(optionalRate) : null;

        const sql = `INSERT INTO products (product_uuid, image_path, manual_rate, cost_rmb, profit_margin, weight_kg, shipping_rate) VALUES (?, ?, ?, ?, ?, ?, ?)`;
        await pool.execute(sql, [productUuid, imagePath, manualRateValue, cost, margin, weight, shiprate]);
        res.json({ success: true, message: '商品创建成功！', productUuid: productUuid });
    } catch (error) {
        console.error("创建失败:", error);
        res.status(500).json({ success: false, message: '服务器内部错误' });
    }
});

// 2. 获取商品详情
app.get('/api/products/:uuid', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM products WHERE product_uuid = ?', [req.params.uuid]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: '找不到商品' });
        const product = rows[0];

        let effectiveRate, rateSource;
        if (product.manual_rate) {
            effectiveRate = parseFloat(product.manual_rate);
            rateSource = "发布锁定";
        } else {
            const [rateRows] = await pool.execute('SELECT rate FROM exchange_rates WHERE id = 1');
            effectiveRate = rateRows.length > 0 ? parseFloat(rateRows[0].rate) : 450;
            rateSource = "系统实时";
        }

        const finalPrice = Math.ceil((product.cost_rmb * (1 + product.profit_margin / 100) * effectiveRate) + (product.weight_kg * product.shipping_rate));
        
        res.json({
            success: true,
            data: {
                imageUrl: product.image_path, // 返回相对路径，让前端自己拼接IP
                finalPriceMMK: finalPrice,
                details: { currentRate: effectiveRate, rateSource: rateSource }
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: '获取失败' });
    }
});

// 3. 获取系统汇率
app.get('/api/system-rate', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT rate, updated_at FROM exchange_rates WHERE id = 1');
        const currentRate = rows.length > 0 ? parseFloat(rows[0].rate) : 450;
        res.json({ success: true, rate: currentRate, lastUpdate: rows[0]?.updated_at });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// ==========================================
// 🏁 启动服务
// ==========================================
app.listen(PORT, () => {
    console.log(`✅ [Server] 后端已启动，端口: ${PORT}`);
    console.log(`✅ [Path] 图片存储目录: ${UPLOAD_DIR}`);
    
    runScraper();
    setInterval(runScraper, 60000); 
});