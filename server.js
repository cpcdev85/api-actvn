const express = require('express');
const puppeteer = require('puppeteer');
const app = express();

app.use(express.json());

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Thiếu thông tin');

    let browser = null;
    try {
        console.log("Khởi động trình duyệt...");
        browser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        
        const page = await browser.newPage();
        console.log("Truy cập trang chủ trường...");
        await page.goto('https://ktdbcl.actvn.edu.vn/dang-nhap.html', { waitUntil: 'domcontentloaded' });

        // BƯỚC MỚI: Tự động tìm và bấm nút "Sign in with Microsoft"
        console.log("Đang tìm nút đăng nhập Microsoft...");
        await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('a, button, div, span'));
            const msBtn = elements.find(el => el.innerText && el.innerText.includes('Microsoft'));
            if (msBtn) msBtn.click();
        });

        // Tăng timeout lên 30s để đợi trang Microsoft load
        console.log("Đợi form điền Email...");
        await page.waitForSelector('input[name="loginfmt"]', { timeout: 30000 });
        await page.type('input[name="loginfmt"]', username);
        await page.click('input[id="idSIButton9"]');

        await new Promise(r => setTimeout(r, 2000)); // Nghỉ 2s chờ hiệu ứng
        
        console.log("Đợi form điền Mật khẩu...");
        await page.waitForSelector('input[name="passwd"]', { visible: true, timeout: 30000 });
        await page.type('input[name="passwd"]', password);
        await page.click('input[id="idSIButton9"]');

        try {
            await page.waitForSelector('input[id="idSIButton9"]', { visible: true, timeout: 5000 });
            await page.click('input[id="idSIButton9"]');
        } catch (e) { }

        console.log("Chờ đăng nhập hoàn tất và lấy HTML...");
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
        const html = await page.content();
        res.status(200).send(html);

    } catch (error) {
        console.error("LỖI CỤ THỂ:", error.message);
        res.status(500).send('Lỗi: ' + error.message);
    } finally {
        if (browser) await browser.close();
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server chạy tại port ' + port));
