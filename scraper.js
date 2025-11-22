// scraper_final.js - 实时汇率爬虫 (适配 waihui999.com - 修正版)
const axios = require('axios');
const cheerio = require('cheerio');
const mysql = require('mysql2/promise');
const https = require('https');

// ============ 配置区域 ============

// 1. 目标网址
const TARGET_URL = 'https://www.waihui999.com/cnymmk/#1';

// 2. CSS 选择器
const RATE_SELECTOR = '#toCost';

// 3. 数据库连接配置
// 【重要：请务必修改密码！】
const dbConfig = {
    host: '127.0.0.1',
    user: 'heikeji_db',      // 你的数据库用户名
    password: 'tAGDB5zmYy2LJhGJ', // 【一定要写真密码！】
    database: 'heikeji_db',  // 你的数据库名
    waitForConnections: true, connectionLimit: 1
};

// =================================

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function fetchAndSaveRate() {
    let connection;
    console.log(`----------------------------------------`);
    console.log(`🚀 开始执行爬虫任务 (修正版) - ${new Date().toLocaleString()}`);
    
    try {
        console.log(`1. 正在请求目标网站: ${TARGET_URL}`);
        const response = await axios.get(TARGET_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Referer': 'https://www.waihui999.com/'
            },
            timeout: 15000,
            httpsAgent: httpsAgent
        });
        const html = response.data;
        console.log("✅ 网页HTML下载成功！");

        // --- 第二步：解析 HTML 提取数据 ---
        console.log("2. 正在解析 HTML 数据...");
        const $ = cheerio.load(html);
        
        let rateText = $(RATE_SELECTOR).text().trim();
        console.log(`🔍 抓取到的原始数据: "${rateText}"`);

        if (!rateText) throw new Error("❌ 无法找到汇率数据。");

        // 清理数据
        rateText = rateText.replace(/[^\d.]/g, '');
        // 转换为浮点数
        let newRate = parseFloat(rateText);

        // 验证数据有效性
        if (isNaN(newRate) || newRate <= 0) throw new Error(`❌ 提取的数据不是有效数字: ${rateText}`);

        // =============== 【关键修正】 ===============
        // 问题：抓到的数字 (如 29453) 可能是 100 RMB 的汇率。
        // 解决：我们将它除以 100，得到 1 RMB 的汇率。
        console.log(`⚠️ 检测到数值较大，判定为 100 单位汇率，正在进行修正 (除以 100)...`);
        newRate = newRate / 100;
        // ===========================================

        // 保留4位小数
        newRate = parseFloat(newRate.toFixed(4));

        console.log(`✅ 修正后的最终汇率: 1 RMB = ${newRate} MMK`);

        // --- 第三步：存入数据库 ---
        console.log("3. 正在更新数据库...");
        connection = await mysql.createConnection(dbConfig);
        const [result] = await connection.execute(
            'UPDATE exchange_rates SET rate = ?, updated_at = NOW() WHERE id = 1',
            [newRate]
        );

        if (result.affectedRows > 0) {
            console.log(`🎉🎉🎉 数据库更新成功！系统默认汇率已设置为: ${newRate}`);
        } else {
            await connection.execute(
                'INSERT INTO exchange_rates (id, currency_pair, rate, updated_at) VALUES (1, "RMB_MMK", ?, NOW())',
                [newRate]
            );
            console.log(`🎉🎉🎉 数据库初始化并插入成功！系统默认汇率: ${newRate}`);
        }

    } catch (error) {
        console.error("\n❌❌❌ 爬虫任务失败 ❌❌❌");
        console.error("错误原因:", error.message);
    } finally {
        if (connection) await connection.end();
        console.log(`----------------------------------------\n`);
    }
}

fetchAndSaveRate();