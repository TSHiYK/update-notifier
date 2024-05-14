import { google } from 'googleapis';
import { chromium } from 'playwright';
import { promises as fs } from 'fs';
import fetch from 'node-fetch';
import { diffLines } from 'diff';
import dotenv from 'dotenv';

dotenv.config();

// 環境変数からWebhook URLとGoogle Credentialsファイルパスを取得
const teamsWebhookUrl = process.env.TEAMS_WEBHOOK_URL || process.env.TEAMS_TEST_WEBHOOK_URL;
const spreadsheetId = process.env.SPREADSHEET_ID;
const googleCredentialsPath = process.env.GOOGLE_CREDENTIALS_PATH;

// 前回の内容を保存するディレクトリ
const contentDir = 'contents';

// ディレクトリの作成
const ensureContentDirExists = async () => {
    try {
        await fs.mkdir(contentDir, { recursive: true });
    } catch (error) {
        console.error(`Failed to create content directory: ${error}`);
    }
};

const getUrlsFromSheet = async () => {
    const googleCredentials = JSON.parse(await fs.readFile(googleCredentialsPath, 'utf-8'));
    const auth = new google.auth.GoogleAuth({
        credentials: googleCredentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Sheet1!A:A', // A列にURLがあると仮定
    });

    return response.data.values.flat();
};

const fetchPageContent = async (url, page, retries = 5) => {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
            const content = await page.evaluate(() => document.body.innerText);
            const title = await page.title();
            return { content, title };
        } catch (error) {
            console.error(`Attempt ${attempt + 1} failed for ${url}: ${error}`);
            if (attempt === retries - 1) {
                return null;
            }
        }
    }
};

const checkIfNewOrUpdated = async (url, page) => {
    const pageData = await fetchPageContent(url, page);
    if (!pageData) return { updated: false, isNew: false, error: true };

    const newContent = pageData.content;
    const newTitle = pageData.title;
    const lastContentFile = `${contentDir}/${encodeURIComponent(url)}.txt`;

    let lastContent = '';
    let isNew = false;
    try {
        lastContent = await fs.readFile(lastContentFile, 'utf-8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            isNew = true;
        } else {
            throw error;
        }
    }

    if (newContent !== lastContent) {
        await fs.writeFile(lastContentFile, newContent, 'utf-8');
        const changes = diffLines(lastContent, newContent).filter(change => change.added || change.removed);
        return { updated: true, isNew, title: newTitle, changes };
    }
    return { updated: false, isNew };
};

const trimString = (str, maxLength = 100) => {
    return str.length > maxLength ? `${str.substring(0, maxLength)}...` : str;
};

const sendUpdateNotification = async (updates) => {
    if (updates.length === 0) return;

    const message = {
        text: '以下のページが更新されました:\n\n' +
            updates.map(({ url, title, changes }) => (
                `**${url} のページが更新されました！**
**タイトル:** ${title}

**変更点:**
\`\`\`diff
${changes.map(change => (change.added ? `+ ${trimString(change.value)}` : change.removed ? `- ${trimString(change.value)}` : '')).join('\n')}
\`\`\`\n\n`
            )).join('\n')
    };

    await fetch(teamsWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message.text })
    });
};

const sendNewUrlNotification = async (newUrls) => {
    if (newUrls.length === 0) return;

    const message = {
        text: '以下の新しいURLが追加されました:\n\n' +
            newUrls.map(({ url, title }) => `- [${title}](${url})\n`).join('\n')
    };

    await fetch(teamsWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message.text })
    });
};

const sendErrorNotification = async (errors) => {
    if (errors.length === 0) return;

    const message = {
        text: '以下のURLでエラーが発生しました:\n\n' +
            errors.map(url => `- ${url}\n`).join('\n')
    };

    await fetch(teamsWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message.text })
    });
};

const checkForUpdates = async () => {
    await ensureContentDirExists();
    const urls = await getUrlsFromSheet();
    const updates = [];
    const newUrls = [];
    const errors = [];

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    });

    const updatePromises = urls.map(async (url) => {
        const page = await context.newPage();
        const result = await checkIfNewOrUpdated(url, page);
        await page.close();

        if (result.error) {
            errors.push(url);
        } else if (result.isNew) {
            newUrls.push({ url, title: result.title });
        } else if (result.updated) {
            updates.push({ url, title: result.title, changes: result.changes });
        } else {
            console.log(`No updates detected for ${url}.`);
        }
    });

    await Promise.allSettled(updatePromises);
    await browser.close();

    await sendUpdateNotification(updates);
    await sendNewUrlNotification(newUrls);
    await sendErrorNotification(errors);
};

// 初回実行
checkForUpdates().then(() => {
    console.log('Update check completed.');
}).catch(error => {
    console.error(`Error during update check: ${error}`);
});
