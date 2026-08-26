const express = require('express');
const puppeteer = require('puppeteer');
const app = express();

app.use(express.json());

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Thiếu thông tin');

    let browser = null;
    try {
        // Dùng Chrome cài sẵn của Docker
        browser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        
        const page = await browser.newPage();
        await page.goto('https://ktdbcl.actvn.edu.vn/dang-nhap.html', { waitUntil: 'domcontentloaded' });

        await page.waitForSelector('input[name="loginfmt"]', { timeout: 10000 });
        await page.type('input[name="loginfmt"]', username);
        await page.click('input[id="idSIButton9"]');

        await new Promise(r => setTimeout(r, 1500)); 
        await page.waitForSelector('input[name="passwd"]', { visible: true, timeout: 10000 });
        await page.type('input[name="passwd"]', password);
        await page.click('input[id="idSIButton9"]');

        try {
            await page.waitForSelector('input[id="idSIButton9"]', { visible: true, timeout: 4000 });
            await page.click('input[id="idSIButton9"]');
        } catch (e) { }

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });
        const html = await page.content();
        res.status(200).send(html);
    } catch (error) {
        res.status(500).send('Lỗi: ' + error.message);
    } finally {
        if (browser) await browser.close();
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server chạy tại port ' + port));
