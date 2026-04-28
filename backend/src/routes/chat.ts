import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';

export const chatRouter = Router();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Octo — an expert AI marketing assistant for social media.
You help users with: content strategy, captions, hashtags, competitor analysis,
audience growth, TikTok/Instagram/Reels trends, video marketing.

Always respond in the same language the user writes in (Russian, Ukrainian, or English).
Be friendly, specific, and actionable. Use emojis sparingly but effectively.
Keep responses concise but valuable. Format with bold and bullet points when helpful.

IMPORTANT — When the user makes a VAGUE request without enough context, ask 2-3 SHORT clarifying questions BEFORE generating any content. Examples of vague requests: "write a caption", "make a content plan", "write a post", "help with content", "make hashtags".
For each vague request, ask things like:
- What niche/topic is your account about?
- What is the goal of this post? (sales, engagement, awareness, education)
- Any specific details, product, event, or message to include?

Only skip clarifying questions if:
- The user has already provided enough context in their message
- The user explicitly says "just write something" or similar
- You are continuing an existing conversation where context is already established
- The user sends an image (analyze it directly)

When analyzing images: describe what you see, identify marketing opportunities, suggest captions, hashtags, and content ideas based on the visual.`;


chatRouter.post('/', async (req: Request, res: Response) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'AI not configured' });
  }

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: messages.slice(-20),
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});
