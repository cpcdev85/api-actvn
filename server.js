const express = require('express');
const { randomUUID } = require('node:crypto');
const puppeteer = require('puppeteer');
const { login, fetchGradeTable, AuthenticationError, pageDiagnostics } = require('./school');
const app = express();

app.use((req, res, next) => { res.set('X-Api-Version', 'actvn-20261014-r2'); next(); });
app.use(express.json());
// THÊM ĐOẠN NÀY ĐỂ NHẬN BÁO THỨC
app.get('/', (req, res) => {
    res.status(200).send('Máy chủ đang thức!');
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) return res.status(400).json({ status: 'bad_request', message: 'Thiếu thông tin' });

    const requestId = randomUUID().slice(0, 8);
    let stage = 'start';
    const progress = nextStage => {
        stage = nextStage;
        console.log(`[actvn-20261014-r2 ${requestId}] ${stage}`);
    };
    let browser = null;
    let page = null;
    
    try {
        progress('launch_browser');
        browser = await puppeteer.launch({
            headless: true,
            timeout: 30000,
            protocolTimeout: 45000,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled'
            ]
        });
        
        progress('browser_ready');
        page = await browser.newPage();
        progress('page_ready');
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        await login(page, username, password, progress);
        const tableHtml = await fetchGradeTable(page, progress);

        // Trả về đúng cái bảng điểm
        res.set('Cache-Control', 'no-store');
        res.status(200).type('html').send(tableHtml);

    } catch (error) {
        if (error instanceof AuthenticationError) {
            console.error(`[actvn-20261014-r2 ${requestId}] authentication_failed stage=${stage}`);
            return res.status(401).json({ success: false, message: error.message });
        }
        console.error(`[actvn-20261014-r2 ${requestId}] automation_error stage=${stage}`, error.message);
        const diagnostics = await pageDiagnostics(page).catch(() => null);
        console.error(`[actvn-20261014-r2 ${requestId}] diagnostics`, diagnostics);

        // QUAN TRỌNG: trả JSON (không phải text thuần) để phía diem_fetch.php parse được
        // và KHÔNG dùng key 'success'/'error' ở đây, vì diem_fetch.php coi 2 key đó là
        // "chắc chắn sai tài khoản/mật khẩu" và sẽ tính vào bộ đếm chống dò mật khẩu -
        // trong khi đây là lỗi automation (timeout, đổi giao diện, MFA...), không liên
        // quan gì đến việc user gõ sai mật khẩu.
        res.status(502).json({
            status: 'automation_error',
            message: 'Không tự động lấy được điểm do lỗi hệ thống (có thể do timeout, trang khảo thí thay đổi giao diện, hoặc tài khoản yêu cầu xác thực 2 bước). Vui lòng thử lại sau hoặc dùng cách Thủ công.',
            debug: error.message,
            stuckUrl: diagnostics?.url || null,
            stage,
            requestId,
        });
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server chạy tại port ' + port));
