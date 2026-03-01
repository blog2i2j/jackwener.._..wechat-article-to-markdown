const axios = require("axios");
const cheerio = require("cheerio");
const TurndownService = require("turndown");
const fs = require("fs");
const path = require("path");

const url = process.argv[2];
if (!url) {
    console.error("Usage: node index.js <wechat-article-url>");
    process.exit(1);
}

const HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

const OUTPUT_DIR = path.join(__dirname, "output");
const IMAGE_CONCURRENCY = 5;

// ============================================================
// Helpers
// ============================================================

/**
 * 从 HTML script 标签中提取发布时间
 */
function extractPublishTime(html) {
    const m1 = html.match(/create_time\s*:\s*JsDecode\('([^']+)'\)/);
    if (m1) return m1[1];

    const m2 = html.match(/create_time\s*:\s*'(\d+)'/);
    if (m2) {
        const ts = parseInt(m2[1], 10);
        return new Date(ts * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    }
    return "";
}

/**
 * 下载单张图片到本地
 */
async function downloadImage(imgUrl, imgDir, index) {
    try {
        if (imgUrl.startsWith("//")) imgUrl = "https:" + imgUrl;
        const ext =
            imgUrl.match(/wx_fmt=(\w+)/)?.[1] ||
            imgUrl.match(/\.(\w{3,4})(?:\?|$)/)?.[1] ||
            "png";
        const filename = `img_${String(index).padStart(3, "0")}.${ext}`;
        const filepath = path.join(imgDir, filename);

        const resp = await axios.get(imgUrl, {
            headers: { ...HEADERS, Referer: "https://mp.weixin.qq.com/" },
            responseType: "arraybuffer",
            timeout: 15000,
        });
        fs.writeFileSync(filepath, resp.data);
        return filename;
    } catch (err) {
        console.warn(`  ⚠ 图片下载失败: ${err.message}`);
        return null;
    }
}

/**
 * 并发下载所有图片，返回 { [remoteUrl]: localPath } 映射
 */
async function downloadAllImages(imgUrls, imgDir) {
    const urlMap = {};
    if (imgUrls.length === 0) return urlMap;

    console.log(`🖼  下载 ${imgUrls.length} 张图片 (并发 ${IMAGE_CONCURRENCY})...`);

    // 分批并发
    for (let i = 0; i < imgUrls.length; i += IMAGE_CONCURRENCY) {
        const batch = imgUrls.slice(i, i + IMAGE_CONCURRENCY);
        const results = await Promise.all(
            batch.map((url, j) => downloadImage(url, imgDir, i + j + 1))
        );
        results.forEach((localFile, j) => {
            if (localFile) {
                urlMap[batch[j]] = `images/${localFile}`;
            }
        });
        process.stdout.write(
            `  ✅ ${Math.min(i + IMAGE_CONCURRENCY, imgUrls.length)}/${imgUrls.length}\r`
        );
    }
    console.log();
    return urlMap;
}

// ============================================================
// Content Processing
// ============================================================

/**
 * 提取文章元数据: 标题、作者、发布时间
 */
function extractMetadata($, html) {
    return {
        title: $("#activity-name").text().trim(),
        author: $("#js_name").text().trim(),
        publishTime: extractPublishTime(html),
    };
}

/**
 * 预处理正文 DOM：修复图片、处理代码块、移除噪声元素
 * 返回 { contentHtml, codeBlocks }
 */
function processContent($, contentEl) {
    // 1) 图片: data-src -> src (微信懒加载)
    contentEl.find("img").each((_, img) => {
        const dataSrc = $(img).attr("data-src");
        if (dataSrc) $(img).attr("src", dataSrc);
    });

    // 2) 代码块: 提取 code-snippet__fix 内容，替换为占位符
    const codeBlocks = [];
    contentEl.find(".code-snippet__fix").each((_, el) => {
        $(el).find(".code-snippet__line-index").remove();
        const lang = $(el).find("pre[data-lang]").attr("data-lang") || "";

        const lines = [];
        $(el)
            .find("code")
            .each((_, codeLine) => {
                const text = $(codeLine).text();
                // 跳过 CSS counter 泄漏的垃圾行
                if (/^[ce]?ounter\(line/.test(text)) return;
                lines.push(text);
            });
        if (lines.length === 0) lines.push($(el).text());

        const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
        codeBlocks.push({ lang, code: lines.join("\n") });
        $(el).replaceWith(`<p>${placeholder}</p>`);
    });

    // 3) 移除噪声元素
    contentEl.find("script, style, .qr_code_pc, .reward_area").remove();

    return { contentHtml: contentEl.html(), codeBlocks };
}

/**
 * HTML -> Markdown，还原代码块，清理格式
 */
function convertToMarkdown(contentHtml, codeBlocks) {
    const turndown = new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
        bulletListMarker: "-",
    });
    turndown.addRule("linebreak", {
        filter: "br",
        replacement: () => "\n",
    });

    let md = turndown.turndown(contentHtml);

    // 还原代码块占位符 (turndown 会把 __ 转义成 \_\_)
    codeBlocks.forEach((block, i) => {
        const escaped = `\\_\\_CODE\\_BLOCK\\_${i}\\_\\_`;
        const raw = `__CODE_BLOCK_${i}__`;
        const fenced = `\n\`\`\`${block.lang}\n${block.code}\n\`\`\`\n`;
        md = md.replace(escaped, fenced);
        md = md.replace(raw, fenced);
    });

    // 清理 &nbsp; 残留
    md = md.replace(/\u00a0/g, " ");
    // 清理多余空行
    md = md.replace(/\n{4,}/g, "\n\n\n");
    // 清理行尾多余空格
    md = md.replace(/[ \t]+$/gm, "");

    return md;
}

/**
 * 替换 Markdown 中的远程图片链接为本地路径
 */
function replaceImageUrls(md, urlMap) {
    return md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, imgUrl) => {
        const local = urlMap[imgUrl];
        return local ? `![${alt}](${local})` : match;
    });
}

/**
 * 拼接最终 Markdown 文件内容
 */
function buildMarkdown({ title, author, publishTime, sourceUrl }, bodyMd) {
    const header = [`# ${title}`, ""];
    if (author) header.push(`> 公众号: ${author}`);
    if (publishTime) header.push(`> 发布时间: ${publishTime}`);
    if (sourceUrl) header.push(`> 原文链接: ${sourceUrl}`);
    if (author || publishTime || sourceUrl) header.push("");
    header.push("---", "");
    return header.join("\n") + bodyMd;
}

// ============================================================
// Main
// ============================================================

async function fetchArticle(url) {
    console.log(`🔄 正在抓取: ${url}`);
    const { data: html } = await axios.get(url, { headers: HEADERS });
    const $ = cheerio.load(html);

    // 提取元数据
    const meta = extractMetadata($, html);
    if (!meta.title) {
        console.error("❌ 未能提取到文章标题，可能触发了验证码");
        if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        fs.writeFileSync(path.join(OUTPUT_DIR, "debug.html"), html);
        console.log("已保存原始 HTML 到 output/debug.html");
        return;
    }
    meta.sourceUrl = url;
    console.log(`📄 标题: ${meta.title}`);
    console.log(`👤 作者: ${meta.author}`);
    console.log(`📅 时间: ${meta.publishTime}`);

    // 处理正文
    const { contentHtml, codeBlocks } = processContent($, $("#js_content"));
    if (!contentHtml) {
        console.error("❌ 未能提取到正文内容");
        return;
    }

    // 转 Markdown
    let md = convertToMarkdown(contentHtml, codeBlocks);

    // 收集所有图片 URL 并下载
    const safeTitle = meta.title.replace(/[/\\?%*:|"<>]/g, "_").slice(0, 80);
    const articleDir = path.join(OUTPUT_DIR, safeTitle);
    const imgDir = path.join(articleDir, "images");
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

    const imgUrls = [...new Set(
        [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1])
    )];
    const urlMap = await downloadAllImages(imgUrls, imgDir);
    md = replaceImageUrls(md, urlMap);

    // 写入文件
    const result = buildMarkdown(meta, md);
    const mdPath = path.join(articleDir, `${safeTitle}.md`);
    fs.writeFileSync(mdPath, result);

    console.log(`✅ 已保存: ${mdPath}`);
    console.log(`📊 Markdown 约 ${md.length} 字符`);
}

fetchArticle(url).catch((err) => {
    console.error("❌ 抓取失败:", err.message);
});
