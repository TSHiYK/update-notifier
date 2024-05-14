const { google } = require('googleapis');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const diff = require('diff');
require('dotenv').config();

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

const fetchPageContent = async (url, retries = 3) => {
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);
        const textContent = $('body').text();
        return { content: textContent, title: $('title').text() };
    } catch (error) {
        if (retries > 0) {
            console.error(`Error fetching the page, retrying... (${retries} retries left)`);
            return fetchPageContent(url, retries - 1);
        } else {
            console.error(`Failed to fetch the page: ${error}`);
            return null;
        }
    }
};

const checkIfNewOrUpdated = async (url) => {
    const pageData = await fetchPageContent(url);
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
        const changes = diff.diffLines(lastContent, newContent).filter(change => change.added || change.removed);
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

    await axios.post(teamsWebhookUrl, message);
};

const sendNewUrlNotification = async (newUrls) => {
    if (newUrls.length === 0) return;

    const message = {
        text: '以下の新しいURLが追加されました:\n\n' +
            newUrls.map(({ url, title }) => `- [${title}](${url})\n`).join('\n')
    };

    await axios.post(teamsWebhookUrl, message);
};

const sendErrorNotification = async (errors) => {
    if (errors.length === 0) return;

    const message = {
        text: '以下のURLでエラーが発生しました:\n\n' +
            errors.map(url => `- ${url}\n`).join('\n')
    };

    await axios.post(teamsWebhookUrl, message);
};

const checkForUpdates = async () => {
    await ensureContentDirExists();
    const urls = await getUrlsFromSheet();
    const updates = [];
    const newUrls = [];
    const errors = [];

    const updatePromises = urls.map(async (url) => {
        const result = await checkIfNewOrUpdated(url);
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

    await Promise.all(updatePromises);
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
