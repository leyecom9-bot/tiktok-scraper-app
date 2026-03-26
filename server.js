/**
 * TikTok Trend Scraper
 *
 * A simple tool to scrape trending TikTok videos and analyze them with AI.
 *
 * CUSTOMIZATION GUIDE:
 * - To change the AI analysis prompt, edit the `analyzeWithAI` function below
 * - To add new fields, update the database schema in `initDatabase` and the UI in views/
 * - To change scraping behavior, modify the `scrapeTikTok` function
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const { createClient } = require('@libsql/client');
const { ApifyClient } = require('apify-client');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Database setup
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:/tmp/tiktok.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDatabase() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS scrape_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      date_range TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER,
      video_id TEXT UNIQUE,
      author TEXT,
      description TEXT,
      views INTEGER,
      likes INTEGER,
      comments INTEGER,
      shares INTEGER,
      video_url TEXT,
      download_url TEXT,
      thumbnail_url TEXT,
      subtitle_url TEXT,
      published_at TEXT,
      transcript TEXT,
      ai_analysis TEXT,
      comment_analysis TEXT,
      hook_type TEXT,
      bookmarked INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES scrape_jobs(id)
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      brief_template TEXT,
      brand_bible TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS briefs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      video_id INTEGER,
      title TEXT,
      content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (video_id) REFERENCES videos(id)
    );
  `);
}

initDatabase().catch(console.error);

// ============================================
// SCRAPING FUNCTION
// ============================================

async function scrapeTikTok(keyword, dateRange, maxResults = 20) {
  const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

  console.log(`Starting TikTok scrape for keyword: ${keyword}, max results: ${maxResults}`);

  const run = await client.actor('clockworks/tiktok-scraper').call({
    searchQueries: [keyword],
    resultsPerPage: maxResults,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
  });

  console.log(`Apify run completed, fetching results...`);

  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  console.log(`Got ${items.length} videos from Apify`);

  const videos = items.map(item => {
    const videoId = item.id || item.videoId || `v_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const authorName = item.authorMeta?.name || item.author || 'Unknown';
    const tiktokUrl = item.webVideoUrl || `https://www.tiktok.com/@${authorName}/video/${videoId}`;
    const downloadUrl = item.videoMeta?.downloadAddr || item.downloadUrl || '';

    const subtitleLinks = item.videoMeta?.subtitleLinks || [];
    const engSubtitle = subtitleLinks.find(l => l.language?.toLowerCase().includes('eng'));
    const subtitleUrl = engSubtitle?.downloadLink || subtitleLinks[0]?.downloadLink || '';

    let publishedAt = item.createTimeISO || '';
    if (!publishedAt && item.createTime) {
      publishedAt = new Date(item.createTime * 1000).toISOString();
    }

    return {
      video_id: videoId,
      author: authorName.startsWith('@') ? authorName : `@${authorName}`,
      description: item.text || item.description || '',
      views: item.playCount || item.views || 0,
      likes: item.diggCount || item.likes || 0,
      comments: item.commentCount || item.comments || 0,
      shares: item.shareCount || item.shares || 0,
      video_url: tiktokUrl,
      download_url: downloadUrl,
      thumbnail_url: item.videoMeta?.coverUrl || item.covers?.default || item.thumbnail || '',
      subtitle_url: subtitleUrl,
      published_at: publishedAt,
    };
  });

  return videos;
}

// ============================================
// AI ANALYSIS FUNCTION
// ============================================

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function downloadVideoAsBase64(url) {
  try {
    console.log(`Downloading video from: ${url.substring(0, 100)}...`);
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });

    if (!response.ok) throw new Error(`Failed to download video: ${response.status}`);

    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    console.log(`Video downloaded, size: ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);
    return base64;
  } catch (error) {
    console.error('Error downloading video:', error.message);
    return null;
  }
}

async function analyzeWithAI(video) {
  const prompt = `You are an expert creative strategist. Analyze this TikTok video ad and return exactly four sections—Visual Hook, Undeniable Proof, Theme, and Funnel Stage.

VIDEO CONTEXT:
- Author: ${video.author}
- Description: ${video.description}
- Views: ${video.views}
- Likes: ${video.likes}
- Comments: ${video.comments}
- Shares: ${video.shares}

Use this framework to determine the Funnel Stage:
- TOF (Top of Funnel): Broad appeal, entertainment, viral trends, or pure storytelling. No clear product pitch yet.
- MOF (Middle of Funnel): Problem/solution aware. Educational content, comparisons, how-to's, or highlighting specific pain points.
- BOF (Bottom of Funnel): High intent. Hard offers, discounts, testimonials, direct product calls-to-action (Shop Now).

Return your analysis in this exact plain-text format:

Visual Hook: <single concise sentence describing the first 1–2 seconds>
Undeniable Proof: <the clearest piece of credibility or evidence shown>
Theme: <2–4-word phrase capturing the concept>
Funnel Stage: <Choose exactly one: TOF, MOF, or BOF>`;

  const contentParts = [];

  const downloadUrl = video.download_url || '';
  if (downloadUrl) {
    const videoBase64 = await downloadVideoAsBase64(downloadUrl);
    if (videoBase64) {
      contentParts.push({ inlineData: { data: videoBase64, mimeType: 'video/mp4' } });
      console.log('Video added to analysis request');
    }
  }

  contentParts.push({ text: prompt });

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-pro',
    contents: [{ role: 'user', parts: contentParts }],
  });

  const analysisText = response.text || '';
  const funnelMatch = analysisText.match(/Funnel Stage:\s*(TOF|MOF|BOF)/i);
  const hookType = funnelMatch ? funnelMatch[1].toUpperCase() : 'N/A';

  return { hook_type: hookType, analysis: analysisText };
}

// ============================================
// COMMENT SCRAPING FUNCTION
// ============================================

async function scrapeComments(videoUrl, maxComments = 50) {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;

  if (!APIFY_TOKEN) {
    console.log('No APIFY_TOKEN found, skipping comment scraping');
    return [];
  }

  try {
    console.log(`Scraping comments for: ${videoUrl}`);

    const response = await fetch(
      `https://api.apify.com/v2/acts/clockworks~tiktok-comments-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postURLs: [videoUrl], maxComments, maxRepliesPerComment: 0 }),
      }
    );

    if (!response.ok) throw new Error(`Apify comments API error: ${response.status}`);

    const data = await response.json();
    const comments = data.map(item => item.text || item.comment || '').filter(c => c.length > 0);
    console.log(`Scraped ${comments.length} comments`);
    return comments;
  } catch (error) {
    console.error('Error scraping comments:', error.message);
    return [];
  }
}

// ============================================
// COMMENT ANALYSIS FUNCTION
// ============================================

async function analyzeCommentsWithAI(comments) {
  if (!comments || comments.length === 0) {
    return { commonQuestions: 'No comments to analyze', keyInsights: 'No comments available' };
  }

  const commentsText = comments.slice(0, 100).join('\n');

  const prompt = `You are an expert at analyzing social media comments to extract valuable insights and identify common questions. You always return your analysis in valid JSON format with two specific fields: commonQuestions and keyInsights.

Analyze these TikTok comments and provide two specific outputs:

Comments to analyze:
${commentsText}

Please return your analysis in the following JSON format:
{
  "commonQuestions": "A concise summary of questions asked in the comments, separated by semicolons. If no questions are found, return 'No questions identified'",
  "keyInsights": "A brief summary of the main themes, sentiments, and notable observations from the comments"
}

Important:
- For commonQuestions: Extract actual questions or implied questions from the comments
- For keyInsights: Focus on sentiment, recurring themes, user concerns, or notable feedback
- Keep each field under 250 characters for compatibility
- Return ONLY valid JSON without any additional text or markdown formatting`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    const responseText = response.text || '';
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        commonQuestions: parsed.commonQuestions || 'No questions identified',
        keyInsights: parsed.keyInsights || 'No insights available',
      };
    }

    return { commonQuestions: 'Analysis failed', keyInsights: 'Could not parse response' };
  } catch (error) {
    console.error('Error analyzing comments:', error.message);
    return { commonQuestions: 'Analysis error', keyInsights: error.message };
  }
}

// ============================================
// TRANSCRIPT DOWNLOAD FUNCTION
// ============================================

async function downloadTranscript(subtitleUrl) {
  if (!subtitleUrl) {
    console.log('No subtitle URL provided');
    return null;
  }

  try {
    console.log(`Downloading transcript from: ${subtitleUrl.substring(0, 80)}...`);

    const response = await fetch(subtitleUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });

    if (!response.ok) throw new Error(`Failed to download: ${response.status}`);

    const text = await response.text();
    let transcript = text;

    if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
      try {
        const json = JSON.parse(text);
        if (Array.isArray(json)) {
          transcript = json.map(item => item.text || item.content || '').join(' ');
        } else if (json.body) {
          transcript = json.body.map(item => item.text || item.content || '').join(' ');
        }
      } catch (e) {}
    } else if (text.includes('-->')) {
      transcript = text
        .split('\n')
        .filter(line => !line.match(/^\d+$/) && !line.includes('-->') && !line.startsWith('WEBVTT') && line.trim())
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    console.log(`Transcript downloaded, length: ${transcript.length} chars`);
    return transcript;
  } catch (error) {
    console.error('Error downloading transcript:', error.message);
    return null;
  }
}

// ============================================
// ROUTES
// ============================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/results/:jobId', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'results.html'));
});

// API: Start a new scrape job
app.post('/api/scrape', async (req, res) => {
  const { keyword, dateRange, maxResults } = req.body;

  if (!keyword) return res.status(400).json({ error: 'Keyword is required' });

  try {
    const result = await db.execute({
      sql: 'INSERT INTO scrape_jobs (keyword, date_range, status) VALUES (?, ?, ?)',
      args: [keyword, dateRange || '7', 'scraping'],
    });

    const jobId = Number(result.lastInsertRowid);

    (async () => {
      try {
        const videos = await scrapeTikTok(keyword, dateRange, maxResults || 20);

        for (const video of videos) {
          await db.execute({
            sql: `INSERT OR IGNORE INTO videos (job_id, video_id, author, description, views, likes, comments, shares, video_url, download_url, thumbnail_url, subtitle_url, published_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
              jobId, video.video_id, video.author, video.description,
              video.views, video.likes, video.comments, video.shares,
              video.video_url, video.download_url, video.thumbnail_url,
              video.subtitle_url, video.published_at,
            ],
          });
        }

        await db.execute({
          sql: 'UPDATE scrape_jobs SET status = ? WHERE id = ?',
          args: ['complete', jobId],
        });
      } catch (error) {
        console.error('Scraping error:', error);
        await db.execute({
          sql: 'UPDATE scrape_jobs SET status = ? WHERE id = ?',
          args: ['error', jobId],
        });
      }
    })();

    res.json({ jobId, status: 'started' });
  } catch (error) {
    console.error('Error creating job:', error);
    res.status(500).json({ error: 'Failed to start scrape job' });
  }
});

// API: Get job status and results
app.get('/api/job/:jobId', async (req, res) => {
  const { jobId } = req.params;

  const jobResult = await db.execute({ sql: 'SELECT * FROM scrape_jobs WHERE id = ?', args: [jobId] });
  const job = jobResult.rows[0];

  if (!job) return res.status(404).json({ error: 'Job not found' });

  const videosResult = await db.execute({
    sql: 'SELECT * FROM videos WHERE job_id = ? ORDER BY views DESC',
    args: [jobId],
  });

  res.json({ job, videos: videosResult.rows });
});

// API: Get all jobs (history)
app.get('/api/jobs', async (req, res) => {
  const result = await db.execute('SELECT * FROM scrape_jobs ORDER BY created_at DESC LIMIT 20');
  res.json(result.rows);
});

// API: Delete a job and its associated videos
app.delete('/api/jobs/:jobId', async (req, res) => {
  const { jobId } = req.params;

  try {
    const videosResult = await db.execute({ sql: 'SELECT id FROM videos WHERE job_id = ?', args: [jobId] });
    const videoIds = videosResult.rows.map(v => Number(v.id));

    if (videoIds.length > 0) {
      const placeholders = videoIds.map(() => '?').join(',');
      await db.execute({
        sql: `UPDATE briefs SET video_id = NULL WHERE video_id IN (${placeholders})`,
        args: videoIds,
      });
    }

    await db.execute({ sql: 'DELETE FROM videos WHERE job_id = ?', args: [jobId] });
    await db.execute({ sql: 'DELETE FROM scrape_jobs WHERE id = ?', args: [jobId] });

    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting job:', err);
    res.status(500).json({ error: 'Failed to delete job' });
  }
});

// API: Analyze a single video with AI (on-demand)
app.post('/api/analyze/:videoId', async (req, res) => {
  const { videoId } = req.params;

  try {
    const videoResult = await db.execute({ sql: 'SELECT * FROM videos WHERE id = ?', args: [videoId] });
    const video = videoResult.rows[0];

    if (!video) return res.status(404).json({ error: 'Video not found' });

    const [videoAnalysis, comments] = await Promise.all([
      analyzeWithAI(video),
      scrapeComments(video.video_url, 50),
    ]);

    const commentAnalysis = await analyzeCommentsWithAI(comments);
    const commentAnalysisJson = JSON.stringify(commentAnalysis);

    await db.execute({
      sql: 'UPDATE videos SET ai_analysis = ?, comment_analysis = ?, hook_type = ? WHERE id = ?',
      args: [videoAnalysis.analysis, commentAnalysisJson, videoAnalysis.hook_type, video.id],
    });

    res.json({
      success: true,
      hook_type: videoAnalysis.hook_type,
      analysis: videoAnalysis.analysis,
      commentAnalysis,
    });
  } catch (error) {
    console.error('Error analyzing video:', error);
    res.status(500).json({ error: 'Failed to analyze video' });
  }
});

// API: Export as CSV
app.get('/api/export/:jobId', async (req, res) => {
  const { jobId } = req.params;

  const videosResult = await db.execute({ sql: 'SELECT * FROM videos WHERE job_id = ?', args: [jobId] });
  const jobResult = await db.execute({ sql: 'SELECT * FROM scrape_jobs WHERE id = ?', args: [jobId] });
  const job = jobResult.rows[0];

  if (!job) return res.status(404).json({ error: 'Job not found' });

  const headers = ['Author', 'Description', 'Views', 'Likes', 'Comments', 'Shares', 'Hook Type', 'AI Analysis'];
  const rows = videosResult.rows.map(v => [
    v.author,
    `"${(v.description || '').replace(/"/g, '""')}"`,
    v.views, v.likes, v.comments, v.shares,
    v.hook_type || '',
    `"${(v.ai_analysis || '').replace(/"/g, '""')}"`,
  ]);

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="tiktok-${job.keyword}-${jobId}.csv"`);
  res.send(csv);
});

// API: Toggle bookmark
app.post('/api/bookmark/:videoId', async (req, res) => {
  const { videoId } = req.params;

  try {
    const videoResult = await db.execute({ sql: 'SELECT * FROM videos WHERE id = ?', args: [videoId] });
    const video = videoResult.rows[0];

    if (!video) return res.status(404).json({ error: 'Video not found' });

    const newStatus = video.bookmarked ? 0 : 1;
    await db.execute({ sql: 'UPDATE videos SET bookmarked = ? WHERE id = ?', args: [newStatus, videoId] });

    res.json({ success: true, bookmarked: newStatus === 1 });
  } catch (error) {
    console.error('Error toggling bookmark:', error);
    res.status(500).json({ error: 'Failed to toggle bookmark' });
  }
});

// API: Get all bookmarked videos
app.get('/api/bookmarks', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM videos WHERE bookmarked = 1 ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error getting bookmarks:', error);
    res.status(500).json({ error: 'Failed to get bookmarks' });
  }
});

// API: Get transcript for a video (on-demand)
app.post('/api/transcript/:videoId', async (req, res) => {
  const { videoId } = req.params;

  try {
    const videoResult = await db.execute({ sql: 'SELECT * FROM videos WHERE id = ?', args: [videoId] });
    const video = videoResult.rows[0];

    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (video.transcript) return res.json({ success: true, transcript: video.transcript });
    if (!video.subtitle_url) return res.json({ success: false, error: 'No captions available for this video' });

    const transcript = await downloadTranscript(video.subtitle_url);

    if (transcript) {
      await db.execute({ sql: 'UPDATE videos SET transcript = ? WHERE id = ?', args: [transcript, video.id] });
      res.json({ success: true, transcript });
    } else {
      res.json({ success: false, error: 'Failed to download transcript' });
    }
  } catch (error) {
    console.error('Error getting transcript:', error);
    res.status(500).json({ error: 'Failed to get transcript' });
  }
});

// ============================================
// PROJECT MANAGEMENT ROUTES
// ============================================

app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'settings.html'));
});

app.get('/api/projects', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM projects ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error getting projects:', error);
    res.status(500).json({ error: 'Failed to get projects' });
  }
});

app.post('/api/projects', async (req, res) => {
  const { name, brief_template, brand_bible } = req.body;

  if (!name) return res.status(400).json({ error: 'Project name is required' });

  try {
    const result = await db.execute({
      sql: 'INSERT INTO projects (name, brief_template, brand_bible) VALUES (?, ?, ?)',
      args: [name, brief_template || '', brand_bible || ''],
    });

    const projectResult = await db.execute({
      sql: 'SELECT * FROM projects WHERE id = ?',
      args: [Number(result.lastInsertRowid)],
    });
    res.json(projectResult.rows[0]);
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

app.put('/api/projects/:id', async (req, res) => {
  const { id } = req.params;
  const { name, brief_template, brand_bible } = req.body;

  try {
    await db.execute({
      sql: 'UPDATE projects SET name = ?, brief_template = ?, brand_bible = ? WHERE id = ?',
      args: [name, brief_template || '', brand_bible || '', id],
    });

    const result = await db.execute({ sql: 'SELECT * FROM projects WHERE id = ?', args: [id] });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

app.delete('/api/projects/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await db.execute({ sql: 'DELETE FROM briefs WHERE project_id = ?', args: [id] });
    await db.execute({ sql: 'DELETE FROM projects WHERE id = ?', args: [id] });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

// ============================================
// BRIEF GENERATION ROUTES
// ============================================

app.get('/briefs', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'briefs.html'));
});

app.get('/api/briefs', async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT b.*, p.name as project_name, v.author, v.description as video_description, v.video_url
      FROM briefs b
      LEFT JOIN projects p ON b.project_id = p.id
      LEFT JOIN videos v ON b.video_id = v.id
      ORDER BY b.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error getting briefs:', error);
    res.status(500).json({ error: 'Failed to get briefs' });
  }
});

app.get('/api/briefs/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.execute({
      sql: `SELECT b.*, p.name as project_name, v.author, v.description as video_description, v.video_url
            FROM briefs b
            LEFT JOIN projects p ON b.project_id = p.id
            LEFT JOIN videos v ON b.video_id = v.id
            WHERE b.id = ?`,
      args: [id],
    });

    const brief = result.rows[0];
    if (!brief) return res.status(404).json({ error: 'Brief not found' });

    res.json(brief);
  } catch (error) {
    console.error('Error getting brief:', error);
    res.status(500).json({ error: 'Failed to get brief' });
  }
});

app.post('/api/generate-brief', async (req, res) => {
  const { video_id, project_id } = req.body;

  if (!video_id || !project_id) return res.status(400).json({ error: 'Video ID and Project ID are required' });

  try {
    const videoResult = await db.execute({ sql: 'SELECT * FROM videos WHERE id = ?', args: [video_id] });
    const projectResult = await db.execute({ sql: 'SELECT * FROM projects WHERE id = ?', args: [project_id] });

    const video = videoResult.rows[0];
    const project = projectResult.rows[0];

    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!video.ai_analysis) return res.status(400).json({ error: 'Please run AI Analysis on this video first' });

    let prompt = `Generate a creative brief based on the following TikTok video analysis.\n\n`;
    prompt += `## VIDEO ANALYSIS\n`;
    prompt += `Author: ${video.author}\n`;
    prompt += `Description: ${video.description}\n`;
    prompt += `Views: ${video.views}, Likes: ${video.likes}, Comments: ${video.comments}\n`;
    prompt += `AI Analysis: ${video.ai_analysis}\n`;

    if (video.comment_analysis) prompt += `\nComment Insights: ${video.comment_analysis}\n`;
    if (video.transcript) prompt += `\nTranscript: ${video.transcript.substring(0, 1500)}...\n`;
    if (project.brand_bible) prompt += `\n## BRAND GUIDELINES\n${project.brand_bible}\n`;

    if (project.brief_template) {
      prompt += `\n## BRIEF TEMPLATE TO FOLLOW\n${project.brief_template}\n`;
      prompt += `\nPlease generate a creative brief following the template above, incorporating insights from the video analysis and brand guidelines.\n`;
    } else {
      prompt += `\nPlease generate a comprehensive creative brief that includes:
1. Campaign Objective
2. Target Audience
3. Key Message
4. Creative Concept (inspired by the analyzed video)
5. Visual Direction
6. Call to Action
7. Deliverables
8. Success Metrics\n`;
    }

    prompt += `\nIMPORTANT: Start your response with a catchy, creative title for this brief on its own line, followed by "---" on a new line, then the brief content. The title should be short (3-7 words) and capture the essence of the creative concept.\n`;

    const aiResult = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    const fullResponse = aiResult.text || 'Failed to generate brief';

    let briefTitle = 'Creative Brief';
    let briefContent = fullResponse;

    if (fullResponse.includes('---')) {
      const parts = fullResponse.split('---');
      briefTitle = parts[0].trim().replace(/^#+ /, '').replace(/\*\*/g, '');
      briefContent = parts.slice(1).join('---').trim();
    }

    const insertResult = await db.execute({
      sql: 'INSERT INTO briefs (project_id, video_id, title, content) VALUES (?, ?, ?, ?)',
      args: [project_id, video_id, briefTitle, briefContent],
    });

    const briefResult = await db.execute({
      sql: 'SELECT * FROM briefs WHERE id = ?',
      args: [Number(insertResult.lastInsertRowid)],
    });

    res.json({ success: true, brief: briefResult.rows[0] });
  } catch (error) {
    console.error('Error generating brief:', error);
    res.status(500).json({ error: 'Failed to generate brief: ' + error.message });
  }
});

app.delete('/api/briefs/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await db.execute({ sql: 'DELETE FROM briefs WHERE id = ?', args: [id] });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting brief:', error);
    res.status(500).json({ error: 'Failed to delete brief' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`TikTok Scraper running at http://localhost:${PORT}`);
});
