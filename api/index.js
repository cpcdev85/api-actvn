const puppeteer = require('puppeteer');
const chromium = require('@sparticuz/chromium');
const { login, fetchGradeTable, AuthenticationError } = require('../school');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).send('Vui lòng sử dụng phương thức POST');
    }
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
        return res.status(400).json({ status: 'bad_request', message: 'Thiếu username hoặc password' });
    }
    let browser = null;
    try {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });
        const page = await browser.newPage();
        await login(page, username, password);
        const tableHtml = await fetchGradeTable(page);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(tableHtml);
    } catch (error) {
        if (error instanceof AuthenticationError) {
            return res.status(401).json({ success: false, message: error.message });
        }
        return res.status(502).json({
            status: 'automation_error',
            message: 'Không tự động lấy được điểm. Vui lòng thử lại sau hoặc dùng cách Thủ công.',
            debug: error.message,
        });
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
};
