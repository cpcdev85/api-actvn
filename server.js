const express = require('express');
const puppeteer = require('puppeteer');
const app = express();

app.use(express.json());

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Thiếu thông tin');

    let browser = null;
    let page = null;
    
    try {
        console.log("Khởi động trình duyệt...");
        browser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        });
        
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log("Truy cập trang chủ trường...");
        await page.goto('https://ktdbcl.actvn.edu.vn/dang-nhap.html', { waitUntil: 'domcontentloaded' });

        // TỐI ƯU: Đọc link trực tiếp từ HTML thay vì click
        console.log("Đang bóc tách link đăng nhập Microsoft...");
        const msAuthUrl = await page.evaluate(() => {
            const btn = document.querySelector('button[data-socialurl*="login.microsoftonline.com"]');
            return btn ? btn.getAttribute('data-socialurl') : null;
        });

        if (msAuthUrl) {
            console.log("Đã tìm thấy link SSO! Đang chuyển hướng trực tiếp sang Microsoft...");
            // Giải mã các ký tự HTML entities (&amp; -> &) để link chuẩn xác
            const cleanUrl = msAuthUrl.replace(/&amp;/g, '&');
            await page.goto(cleanUrl, { waitUntil: 'domcontentloaded' });
        } else {
            throw new Error("Không bóc tách được link Microsoft từ giao diện.");
        }

        console.log("Đợi form điền Email...");
        await page.waitForSelector('input[name="loginfmt"]', { timeout: 30000 });
        await page.type('input[name="loginfmt"]', username);
        await page.click('input[id="idSIButton9"]');

        await new Promise(r => setTimeout(r, 2000));
        
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
        let errorMsg = `Lỗi: ${error.message}\n\n`;
        if (page) {
            try {
                const currentUrl = await page.url();
                errorMsg += `--- GÓC DEBUG ---\n`;
                errorMsg += `URL khi bị kẹt: ${currentUrl}\n\n`;
            } catch (e) {}
        }
        res.status(500).send(errorMsg);
    } finally {
        if (browser) await browser.close();
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server chạy tại port ' + port));
