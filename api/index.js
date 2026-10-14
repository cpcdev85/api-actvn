const puppeteer = require('puppeteer');
const chromium = require('@sparticuz/chromium');
const { login, fetchGradeTable, AuthenticationError, pageDiagnostics } = require('../school');

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
    let page = null;
    let stage = 'launch_browser';
    const progress = value => { stage = value; console.log('[actvn-20261014-r2]', stage); };
    try {
        browser = await puppeteer.launch({
            args: chromium.args,
            timeout: 30000,
            protocolTimeout: 45000,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });
        progress('browser_ready');
        page = await browser.newPage();
        progress('page_ready');
        await login(page, username, password, progress);
        const tableHtml = await fetchGradeTable(page, progress);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(tableHtml);
    } catch (error) {
        if (error instanceof AuthenticationError) {
            return res.status(401).json({ success: false, message: error.message });
        }
        console.error('[actvn-20261014-r2] automation_error', stage, error.message, await pageDiagnostics(page).catch(() => null));
        return res.status(502).json({
            status: 'automation_error',
            message: 'Không tự động lấy được điểm. Vui lòng thử lại sau hoặc dùng cách Thủ công.',
            debug: error.message,
            stage,
        });
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
};
