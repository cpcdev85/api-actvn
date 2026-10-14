const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const chromium = require('@sparticuz/chromium');
const { fetchGradeTable, extractGradeTable, GRADES_URL } = require('../school');
let browser;
before(async () => {
    browser = await puppeteer.launch({ pipe: true, args: chromium.args, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || await chromium.executablePath(), headless: true });
});
after(async () => { if (browser) await browser.close(); });
const headers = ['#', '', 'Năm học', 'Học kỳ', 'Môn thi', 'Lần', 'TP1', 'TP2', 'ĐQT', 'Điểm thi', 'Điểm HP', 'Điểm chữ'];
const records = [
    ['1', '', '2025-2026', '2', 'Môn kiểm thử', '1', '7', '9', '7.6', '1', '3', 'F'],
    ['2', '', '2025-2026', '2', 'Môn kiểm thử', '2', '7', '9', '7.6', '', '', ''],
    ['3', '', '2025-2026', '2', 'Môn khác', '1', '0', '0', '0', '0', '0', 'F'],
];
function html({ limit = '0', filter = '', offset = '0', rows = records, total = rows.length } = {}) {
    return `<form id="adminForm" method="POST" action="${GRADES_URL}">
    <input name="csrf_test_token" value="1" type="hidden"><input name="learnerId" value="123" type="hidden">
    <input name="task" value=""><input name="boxchecked" value="0"><input name="limitstart" value="${offset}">
    <input name="filter[search]" value="${filter}"><select name="filter[term]"><option value="">Học kỳ</option><option value="1">1</option></select>
    <select id="list_limit" name="list[limit]" onchange="this.form.submit()">
    <option value="20" ${limit === '20' ? 'selected' : ''}>20</option><option value="0" ${limit === '0' ? 'selected' : ''}>Tất cả</option></select>
    <table class="table table-bordered"><thead><tr>${headers.map(x => `<th>${x}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(row => `<tr>${row.map(x => `<td>${x}</td>`).join('')}</tr>`).join('')}</tbody></table>
    <nav class="pagination__wrapper">1 - ${rows.length} / ${total} items</nav></form>`;
}
async function mock(initial, final = html()) {
    const page = await browser.newPage();
    const submissions = [];
    await page.setRequestInterception(true);
    page.on('request', request => {
        if (request.isNavigationRequest()) {
            if (request.method() === 'POST') submissions.push(new URLSearchParams(request.postData()));
            request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: request.method() === 'POST' ? final : initial });
        } else request.abort();
    });
    return { page, submissions };
}
test('already All: no unnecessary navigation, keeps retakes, blanks and zero scores', async () => {
    const { page, submissions } = await mock(html());
    try {
        const result = await fetchGradeTable(page);
        assert.equal(submissions.length, 0);
        assert.equal((result.match(/<tr>/g) || []).length, 4);
        assert.match(result, /<td>0<\/td>/);
        assert.match(result, /<td><\/td><td><\/td><td><\/td>/);
    } finally { await page.close(); }
});
test('20 rows setting: single POST selecting All and preserving current CSRF/learner fields', async () => {
    const { page, submissions } = await mock(html({ limit: '20' }));
    try {
        await fetchGradeTable(page);
        assert.equal(submissions.length, 1);
        assert.equal(submissions[0].get('list[limit]'), '0');
        assert.equal(submissions[0].get('csrf_test_token'), '1');
        assert.equal(submissions[0].get('learnerId'), '123');
    } finally { await page.close(); }
});
test('clears saved filters and resets pagination offset even when All was selected', async () => {
    const { page, submissions } = await mock(html({ filter: 'Môn khác', offset: '20' }));
    try {
        await fetchGradeTable(page);
        assert.equal(submissions.length, 1);
        assert.equal(submissions[0].get('filter[search]'), '');
        assert.equal(submissions[0].get('filter[term]'), '');
        assert.equal(submissions[0].get('limitstart'), '0');
        assert.equal(submissions[0].get('task'), '');
    } finally { await page.close(); }
});
test('rejects partial results instead of returning success', async () => {
    const { page } = await mock(html({ total: 19 }));
    try { await assert.rejects(fetchGradeTable(page), /chưa lấy đủ/); }
    finally { await page.close(); }
});
test('rejects a different table or changed structure', async () => {
    const page = await browser.newPage();
    try {
        await page.setContent('<form id="adminForm"><table><thead><tr><th>Thông báo</th></tr></thead></table></form>');
        await assert.rejects(page.evaluate(extractGradeTable), /đúng cấu trúc/);
    } finally { await page.close(); }
});
test('valid empty grade table is returned', async () => {
    const { page } = await mock(html({ rows: [] }));
    try { assert.match(await fetchGradeTable(page), /<tbody><\/tbody>/); }
    finally { await page.close(); }
});

async function authMock(mode) {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => {
        if (!request.isNavigationRequest()) return request.abort();
        const url = new URL(request.url());
        let body;
        if (url.hostname === 'ktdbcl.actvn.edu.vn') {
            body = '<button data-socialurl="https://login.microsoftonline.com/test">Microsoft</button>';
        } else if (url.pathname === '/stay') {
            body = mode === 'stay_text' ? '<h1>Stay signed in?</h1><input id="idSIButton9" type="button" onclick="location.href=\'https://ktdbcl.actvn.edu.vn/hvsv.html\'">' : '<div id="KmsiDescription">Stay signed in?</div><input id="idSIButton9" type="button" onclick="location.href=\'https://ktdbcl.actvn.edu.vn/hvsv.html\'">';
        } else {
            const action = mode === 'wrong' ? "document.body.innerHTML='<div id=\"passwordError\">Sai mật khẩu</div>'" : `location.href='${['stay', 'stay_text'].includes(mode) ? 'https://login.microsoftonline.com/stay' : 'https://ktdbcl.actvn.edu.vn/hvsv.html'}'`;
            body = `<input name="loginfmt"><input id="idSIButton9" type="button"><script>
            document.querySelector('#idSIButton9').onclick=()=>{
                document.body.innerHTML='<input name="passwd" type="password"><input id="idSIButton9" type="button">';
                document.querySelector('#idSIButton9').onclick=()=>{${action}};
            };</script>`;
        }
        request.respond({status:200,contentType:'text/html; charset=utf-8',body});
    });
    return page;
}
for (const mode of ['direct', 'stay', 'stay_text']) {
    test(`login observes school return (${mode}) without navigation race`, async () => {
        const { login } = require('../school');
        const page = await authMock(mode);
        try {
            await login(page, 'test@example.invalid', 'mock-password');
            assert.equal(new URL(page.url()).hostname, 'ktdbcl.actvn.edu.vn');
        } finally { await page.close(); }
    });
}
test('explicit Microsoft password error is classified as authentication failure', async () => {
    const { login, AuthenticationError } = require('../school');
    const page = await authMock('wrong');
    try { await assert.rejects(login(page, 'test@example.invalid', 'mock-password'), AuthenticationError); }
    finally { await page.close(); }
});

test('MFA is reported as automation failure, not a wrong password', async () => {
    const { detectAuthState } = require('../school');
    const page = await browser.newPage();
    try {
        await page.setContent('<div id="idDiv_SAOTCC_Description">Enter your verification code</div><input name="otc">');
        const state = await page.evaluate(detectAuthState, 'https://ktdbcl.actvn.edu.vn', false);
        assert.match(state.blocked, /MFA\/OTP/);
        assert.equal(state.error, undefined);
    } finally { await page.close(); }
});
test('diagnostics never includes filled username/password values or URL query', async () => {
    const { pageDiagnostics } = require('../school');
    const { page } = await mock(html());
    try {
        await page.goto(GRADES_URL);
        await page.setContent('<input id="user" name="loginfmt" value="PRIVATE_EMAIL"><input name="passwd" type="password" value="PRIVATE_PASSWORD">');
        const report = await pageDiagnostics(page);
        const text = JSON.stringify(report);
        assert.equal(text.includes('PRIVATE_'), false);
        assert.equal(report.url.includes('?'), false);
    } finally { await page.close(); }
});
