const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

const ask = question => new Promise(resolve => rl.question(question, resolve));
const normalizeAccountName = value => String(value || '').trim().replace(/^@/, '').toLowerCase();
const safeAccountName = value => normalizeAccountName(value).replace(/[^a-z0-9._-]/g, '_');

(async () => {
    const accountArg = process.argv[2];
    const accountName = normalizeAccountName(accountArg || await ask('Instagram username to save (leave blank for default session.json): '));
    const sessionsDir = path.join(__dirname, 'sessions');
    const targetFile = accountName
        ? path.join(sessionsDir, `${safeAccountName(accountName)}.json`)
        : path.join(__dirname, 'session.json');

    console.log('Launching browser...');
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log('Opening Instagram login page...');
    await page.goto('https://www.instagram.com/accounts/login/');

    console.log('');
    console.log('INSTRUCTIONS:');
    console.log('1. In the browser window, log into the Instagram account you want to save.');
    console.log('2. After you see your home feed, come back here.');
    console.log('3. Press ENTER to save the session.');
    console.log('');

    await new Promise(resolve => rl.once('line', resolve));

    console.log(`Saving session to ${targetFile} ...`);
    const sessionData = await context.storageState();
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, JSON.stringify(sessionData, null, 2));

    console.log('Session saved successfully.');
    console.log(`File location: ${targetFile}`);

    await browser.close();
    rl.close();
})().catch(async error => {
    console.error('Save session error:', error.message);
    rl.close();
    process.exitCode = 1;
});
