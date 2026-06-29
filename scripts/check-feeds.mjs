#!/usr/bin/env node
/**
 * 友链订阅机器人 — GitHub Actions 定时任务
 * 每 30 分钟检查友链 RSS，发现新文章通过飞书机器人推送。
 *
 * 用法：node scripts/check-feeds.mjs
 * 环境变量：
 *   FEISHU_WEBHOOK — 飞书机器人 Webhook 地址
 *   FRIENDS_API    — friends-location 接口地址（默认 http://BAMBOO/api/friends-location）
 */

const FRIENDS_API =
  process.env.FRIENDS_API || 'https://bambooo.top/api/friends-location'

const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK || ''
const STATE_FILE = new URL('../../feed-state.json', import.meta.url).pathname

// ======================== 工具函数 ========================

/** 简易 RSS/Atom XML 解析（零依赖） */
function parseFeedXML(xml) {
  const articles = []

  // 先匹配 <item>（RSS 2.0）或 <entry>（Atom）
  const blockRegex = /<(item|entry)>([\s\S]*?)<\/\1>/g
  let match
  while ((match = blockRegex.exec(xml))) {
    const block = match[2]
    const title = extract(block, 'title')
    const link = extractLink(block) || extract(block, 'link')
    const pubDate =
      extract(block, 'pubDate') ||
      extract(block, 'published') ||
      extract(block, 'updated') ||
      extract(block, 'dc:date')
    const description =
      extractCDATA(block, 'description') || extractCDATA(block, 'summary')

    if (title && link) {
      articles.push({
        title: cleanText(title),
        link: cleanText(link).split('?')[0],
        pubDate: cleanText(pubDate),
        excerpt: cleanText(description).slice(0, 150),
      })
    }
  }
  return articles
}

function extractCDATA(block, tag) {
  const re = new RegExp(
    `<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`,
    'i',
  )
  return (block.match(re) || [])[1] || ''
}

function extract(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  return (block.match(re) || [])[1] || ''
}

function extractLink(block) {
  // Atom: <link href="..." />
  const atom = block.match(/<link[^>]+href="([^"]+)"/i)
  if (atom) return atom[1]
  return ''
}

function cleanText(str) {
  return str
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .trim()
}

/** 发送飞书通知 */
async function sendFeishuCard(articles) {
  if (!FEISHU_WEBHOOK) {
    console.log('⚠️  未配置 FEISHU_WEBHOOK，跳过通知')
    return
  }

  // 分组：按作者聚合
  const grouped = {}
  for (const a of articles) {
    if (!grouped[a.author]) grouped[a.author] = []
    grouped[a.author].push(a)
  }

  const elements = []
  for (const [author, list] of Object.entries(grouped)) {
    for (const a of list) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**[${a.author}](https://${a.author})**  &nbsp;·&nbsp; ${a.pubDate?.slice(0, 10) || ''}\n[${a.title}](${a.link})`,
        },
      })
      if (a.excerpt) {
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: a.excerpt },
        })
      }
      elements.push({ tag: 'hr' })
    }
  }
  // 去掉最后一个 hr
  if (elements.length > 0 && elements[elements.length - 1].tag === 'hr') {
    elements.pop()
  }

  const body = {
    msg_type: 'interactive',
    card: {
      header: {
        template: 'turquoise',
        title: { tag: 'plain_text', content: '📬 友链更新 · 订阅机器人' },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `共 **${articles.length}** 篇新文章，来自 **${Object.keys(grouped).length}** 位作者`,
          },
        },
        { tag: 'hr' },
        ...elements,
        {
          tag: 'note',
          elements: [
            {
              tag: 'plain_text',
              content: `🕐 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
            },
          ],
        },
      ],
    },
  }

  const res = await fetch(FEISHU_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const result = await res.json()
  if (result.msg !== 'success' && result.code !== 0) {
    console.error('飞书通知失败:', JSON.stringify(result))
  } else {
    console.log(`✅ 已发送飞书通知：${articles.length} 篇新文章`)
  }
}

/** 从博客 API 获取友链数据（friends-location 接口自带 rss 字段） */
async function fetchFriendsWithRss() {
  try {
    const res = await fetch(FRIENDS_API, {
      headers: { 'User-Agent': 'Yohaku-Subscribe-Bot/1.0' },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      console.error('获取友链数据失败 HTTP', res.status)
      return []
    }
    const json = await res.json()
    const list = json?.friends || []
    // friends-location 接口已包含 rss 字段
    return list
      .filter((f) => f.rss && typeof f.rss === 'string' && f.rss.startsWith('http'))
      .map((f) => ({
        id: String(f.id),
        name: f.name || '未知',
        url: f.url || '',
        rss: f.rss,
      }))
  } catch (e) {
    console.error('获取友链数据失败:', e.message)
    return []
  }
}
/** 加载上次状态 */
function loadState() {
  try {
    const raw = require('fs').readFileSync(STATE_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** 保存当前状态 */
function saveState(state) {
  require('fs').writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

// ======================== 主流程 ========================

async function main() {
  console.log('🔍 开始检查友链更新…')
  const friends = await fetchFriendsWithRss()
  if (friends.length === 0) {
    console.log('没有找到带 RSS 的友链')
    return
  }
  console.log(`找到 ${friends.length} 个有 RSS 的友链`)

  const state = loadState()
  const allNewArticles = []

  for (const friend of friends) {
    console.log(`  检查: ${friend.name} → ${friend.rss}`)
    try {
      const res = await fetch(friend.rss, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Yohaku-RSS-Bot/1.0)' },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) {
        console.log(`    HTTP ${res.status}，跳过`)
        continue
      }
      const xml = await res.text()
      const articles = parseFeedXML(xml)
      console.log(`    解析到 ${articles.length} 篇文章`)

      // 对比已知状态
      const knownUrls = new Set(state[friend.id]?.knownUrls || [])
      const newArticles = articles.filter((a) => !knownUrls.has(a.link))

      if (newArticles.length > 0) {
        console.log(`    🆕 ${newArticles.length} 篇新文章！`)
        for (const a of newArticles) {
          allNewArticles.push({ ...a, author: friend.name, authorUrl: friend.url })
        }
        // 更新已知 URLs（只保留最近 50 条，避免无限增长）
        const updatedUrls = [
          ...newArticles.map((a) => a.link),
          ...(state[friend.id]?.knownUrls || []),
        ].slice(0, 50)
        state[friend.id] = {
          lastChecked: new Date().toISOString(),
          knownUrls: updatedUrls,
        }
      } else {
        console.log('    无新文章')
      }
    } catch (e) {
      console.log(`    ❌ 错误: ${e.message}`)
    }
  }

  // 发送通知
  if (allNewArticles.length > 0) {
    await sendFeishuCard(allNewArticles)
  } else {
    console.log('所有友链均无新文章')
  }

  // 保存状态
  saveState(state)
  console.log(`💾 状态已保存到 ${STATE_FILE}`)
}

main().catch((e) => {
  console.error('❌ 执行失败:', e)
  process.exit(1)
})
