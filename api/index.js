const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

module.exports = async (req, res) => {
    // Chỉ nhận request dạng POST từ PHP
    if (req.method !== 'POST') {
        return res.status(405).send('Vui lòng sử dụng phương thức POST');
    }
    
    // Lấy tài khoản/mật khẩu từ body
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).send('Thiếu username hoặc password');
    }

    let browser = null;
    try {
        // Cấu hình khởi chạy Chrome siêu nhẹ trên Vercel
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        
        // Truy cập trang web trường
        await page.goto('https://ktdbcl.actvn.edu.vn/dang-nhap.html', { waitUntil: 'domcontentloaded' });

        // 1. Điền Tên đăng nhập
        await page.waitForSelector('input[name="loginfmt"]', { timeout: 5000 });
        await page.type('input[name="loginfmt"]', username);
        await page.click('input[id="idSIButton9"]');

        // 2. Chờ form Mật khẩu xuất hiện và điền (đợi hiệu ứng slide của MS)
        await new Promise(r => setTimeout(r, 1500)); 
        await page.waitForSelector('input[name="passwd"]', { visible: true, timeout: 5000 });
        await page.type('input[name="passwd"]', password);
        await page.click('input[id="idSIButton9"]');

        // 3. Xử lý màn hình "Duy trì đăng nhập" (Stay signed in)
        try {
            await page.waitForSelector('input[id="idSIButton9"]', { visible: true, timeout: 3000 });
            await page.click('input[id="idSIButton9"]');
        } catch (e) {
            // Không có màn hình này thì bỏ qua
        }

        // 4. Chờ trang của trường load xong và lấy HTML
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 });
        const html = await page.content();
        
        // Trả kết quả về cho PHP
        res.status(200).send(html);
        
    } catch (error) {
        res.status(500).send('Lỗi quá trình chạy Chrome: ' + error.message);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
};
