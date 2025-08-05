// Keep the original function for fallback purposes
function formatSearchResults(query: string, results: any[], overallSummary: string, searchInfo: any, searchType: 'normal' | 'dork' = 'normal', searchContext: string = ''): string {
  const searchTypeIcon = searchType === 'dork' ? '🎯' : '🔍';
  const searchTypeText = searchType === 'dork' ? 'Google Dork' : 'Search';
  
  let message = `${searchTypeIcon} **${searchTypeText} Results for: "${query}"**\n\n`;
  
  if (searchType === 'dork' && searchContext) {
    message += `🔧 **Search Type:** ${searchContext}\n\n`;
  }
  
  if (overallSummary) {
    message += `🤖 **AI Overview:**\n${overallSummary}\n\n`;
  }
  
  message += `📊 Found ${searchInfo.totalResults} results in ${searchInfo.searchTime} seconds\n`;
  message += `📋 **Top 3 Results:**\n\n`;
  
  results.forEach((result, index) => {
    message += `**${index + 1}. ${result.title}**\n`;
    message += `🌐 ${result.displayLink}\n`;
    message += `📝 ${result.snippet}\n`;
    
    if (result.aiSummary) {
      message += `🤖 *AI Insight: ${result.aiSummary}*\n`;
    }
    
    message += `🔗 [Read more](${result.link})\n\n`;
  });
  
  const tipText = searchType === 'dork' ? 
    '💡 *Tip: Try /examples for Google Dork examples or ask me anything else!*' :
    '💡 *Tip: Use Google Dork operators for specific searches or ask me anything else!*';
  
  message += tipText;
  
  return message;
}// Cloudflare Worker for AI Search Engine Telegram Bot
// This bot integrates Google Custom Search API with Cloudflare AI for intelligent search results

interface Environment {
  TELEGRAM_BOT_TOKEN: string;
  GOOGLE_SEARCH_API_KEY: string;
  GOOGLE_SEARCH_ENGINE_ID: string;
  AI: any; // Cloudflare AI binding
}

interface TelegramUpdate {
  message?: {
    message_id: number;
    from: {
      id: number;
      first_name: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    text?: string;
  };
}

interface GoogleSearchResult {
  kind: string;
  items?: Array<{
    title: string;
    link: string;
    snippet: string;
    displayLink: string;
    formattedUrl: string;
  }>;
  searchInformation: {
    totalResults: string;
    searchTime: number;
  };
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url);
    
    // Handle Telegram webhook
    if (request.method === 'POST' && url.pathname === '/webhook') {
      return handleTelegramWebhook(request, env);
    }
    
    // Handle setup endpoint
    if (request.method === 'GET' && url.pathname === '/setup') {
      return handleSetup(env);
    }
    
    return new Response('AI Search Bot is running!', { status: 200 });
  }
};

async function handleTelegramWebhook(request: Request, env: Environment): Promise<Response> {
  try {
    const update: TelegramUpdate = await request.json();
    
    if (update.message?.text) {
      await processMessage(update.message, env);
    }
    
    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('Webhook error:', error);
    return new Response('Error', { status: 500 });
  }
}

async function processMessage(message: any, env: Environment): Promise<void> {
  const chatId = message.chat.id;
  const text = message.text;
  
  // Handle commands
  if (text.startsWith('/start')) {
    await sendMessage(chatId, getWelcomeMessage(), env);
    return;
  }
  
  if (text.startsWith('/help')) {
    await sendMessage(chatId, getHelpMessage(), env);
    return;
  }
  
  if (text.startsWith('/dork')) {
    await sendMessage(chatId, getDorkHelpMessage(), env);
    return;
  }
  
  if (text.startsWith('/examples')) {
    await sendMessage(chatId, getDorkExamplesMessage(), env);
    return;
  }
  
  // Handle search queries
  if (text && text.length > 0 && !text.startsWith('/')) {
    const searchType = detectSearchType(text);
    const loadingMessage = searchType === 'dork' ? 
      '🔍 Executing Google Dork search and analyzing results...' : 
      '🔍 Searching and analyzing results...';
    
    await sendMessage(chatId, loadingMessage, env);
    await handleSearchQuery(chatId, text, env, searchType);
  }
}

async function handleSearchQuery(chatId: number, query: string, env: Environment, searchType: 'normal' | 'dork' = 'normal'): Promise<void> {
  try {
    let processedQuery = query;
    let searchContext = '';
    
    // Process Google Dork queries
    if (searchType === 'dork') {
      const dorkResult = processGoogleDork(query);
      processedQuery = dorkResult.query;
      searchContext = dorkResult.context;
    }
    
    // Perform Google Custom Search
    const searchResults = await performGoogleSearch(processedQuery, env);
    
    if (!searchResults.items || searchResults.items.length === 0) {
      const noResultsMessage = searchType === 'dork' ? 
        '❌ No results found for your Google Dork query. Try adjusting your operators or search terms.' :
        '❌ No results found for your query. Please try different keywords.';
      await sendMessage(chatId, noResultsMessage, env);
      return;
    }
    
    // Get top 3 results
    const topResults = searchResults.items.slice(0, 3);
    
    // Generate AI summary for each result with search context
    const enrichedResults = await Promise.all(
      topResults.map(async (result) => {
        const aiSummary = await generateAISummary(result.snippet, query, searchContext, env);
        return {
          ...result,
          aiSummary
        };
      })
    );
    
    // Generate overall search summary
    const overallSummary = await generateOverallSummary(query, enrichedResults, searchContext, env);
    
    // Send results individually
    await sendSearchResultsIndividually(chatId, query, enrichedResults, overallSummary, searchResults.searchInformation, searchType, searchContext, env);
    
  } catch (error) {
    console.error('Search error:', error);
    await sendMessage(chatId, '❌ Sorry, there was an error processing your search. Please try again.', env);
  }
}

async function performGoogleSearch(query: string, env: Environment): Promise<GoogleSearchResult> {
  const searchUrl = new URL('https://www.googleapis.com/customsearch/v1');
  searchUrl.searchParams.set('key', env.GOOGLE_SEARCH_API_KEY);
  searchUrl.searchParams.set('cx', env.GOOGLE_SEARCH_ENGINE_ID);
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('num', '10'); // Get max results, we'll filter to top 3
  
  const response = await fetch(searchUrl.toString());
  
  if (!response.ok) {
    throw new Error(`Google Search API error: ${response.status}`);
  }
  
  return await response.json();
}

// Google Dork detection and processing functions
function detectSearchType(query: string): 'normal' | 'dork' {
  const dorkOperators = [
    'site:', 'filetype:', 'ext:', 'inurl:', 'intitle:', 'intext:', 'cache:', 'link:',
    'related:', 'info:', 'define:', 'stocks:', 'weather:', 'map:', 'movie:', 'in:',
    'allinurl:', 'allintitle:', 'allintext:', 'allinanchor:', 'daterange:', 'numrange:',
    'author:', 'group:', 'insubject:', 'msgid:', 'inanchor:', 'loc:', 'location:',
    '"', '-', '+', '*', '..', 'OR', 'AND', '(', ')'
  ];
  
  const hasQuotes = query.includes('"') && query.split('"').length > 2;
  const hasOperators = dorkOperators.some(op => query.toLowerCase().includes(op.toLowerCase()));
  const hasAdvancedOperators = /[\+\-\*\(\)]|OR|AND/i.test(query);
  
  return (hasQuotes || hasOperators || hasAdvancedOperators) ? 'dork' : 'normal';
}

function processGoogleDork(query: string): { query: string; context: string } {
  let context = 'Advanced Google Dork search';
  const originalQuery = query;
  
  // Analyze the dork query to provide context
  const contextMappings = [
    { pattern: /site:([^\s]+)/i, description: 'searching within specific website' },
    { pattern: /filetype:([^\s]+)/i, description: 'filtering by file type' },
    { pattern: /ext:([^\s]+)/i, description: 'searching for specific file extensions' },
    { pattern: /inurl:([^\s]+)/i, description: 'finding pages with specific URL patterns' },
    { pattern: /intitle:([^\s]+)/i, description: 'searching in page titles' },
    { pattern: /intext:([^\s]+)/i, description: 'searching within page content' },
    { pattern: /cache:([^\s]+)/i, description: 'accessing cached versions' },
    { pattern: /link:([^\s]+)/i, description: 'finding pages linking to specific URLs' },
    { pattern: /related:([^\s]+)/i, description: 'finding related websites' },
    { pattern: /info:([^\s]+)/i, description: 'getting information about specific URLs' },
    { pattern: /define:([^\s]+)/i, description: 'finding definitions' },
    { pattern: /allinurl:([^\s]+)/i, description: 'all terms must appear in URL' },
    { pattern: /allintitle:([^\s]+)/i, description: 'all terms must appear in title' },
    { pattern: /allintext:([^\s]+)/i, description: 'all terms must appear in content' },
    { pattern: /inanchor:([^\s]+)/i, description: 'searching in anchor text' },
    { pattern: /"([^"]+)"/g, description: 'exact phrase matching' }
  ];
  
  const detectedOperators = [];
  for (const mapping of contextMappings) {
    const match = query.match(mapping.pattern);
    if (match) {
      detectedOperators.push(mapping.description);
    }
  }
  
  if (detectedOperators.length > 0) {
    context = `Google Dork search (${detectedOperators.join(', ')})`;
  }
  
  // Advanced operator detection
  if (query.includes(' OR ')) {
    context += ' with OR logic';
  }
  if (query.includes(' AND ')) {
    context += ' with AND logic';
  }
  if (query.includes('-')) {
    context += ' with exclusions';
  }
  if (query.includes('+')) {
    context += ' with required terms';
  }
  if (query.includes('*')) {
    context += ' with wildcards';
  }
  if (query.includes('..')) {
    context += ' with range search';
  }
  
  return { query: originalQuery, context };
}

async function generateAISummary(snippet: string, originalQuery: string, searchContext: string, env: Environment): Promise<string> {
  try {
    const contextPrompt = searchContext ? 
      `This is from a ${searchContext}.` : 
      `This is from a regular search.`;
    
    const prompt = `${contextPrompt} Analyze this search result snippet in relation to the query "${originalQuery}":

Snippet: "${snippet}"

Provide a concise, informative summary (max 2 sentences) that explains how this result relates to the search query and highlights the key information. ${searchContext ? 'Consider the advanced search context in your analysis.' : ''}`;

    const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 120
    });

    return response.response || 'AI analysis unavailable.';
  } catch (error) {
    console.error('AI summary error:', error);
    return 'AI analysis unavailable.';
  }
}

async function generateOverallSummary(query: string, results: any[], searchContext: string, env: Environment): Promise<string> {
  try {
    const resultsText = results.map(r => `${r.title}: ${r.snippet}`).join('\n\n');
    const contextPrompt = searchContext ? 
      `This was a ${searchContext} for "${query}".` : 
      `This was a search for "${query}".`;
    
    const prompt = `${contextPrompt} Based on these search results, provide a brief overall summary (2-3 sentences) of what the user can learn about this topic:

${resultsText}

Focus on the main themes and key insights across all results. ${searchContext ? 'Consider how the advanced search parameters helped target specific information.' : ''}`;

    const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 180
    });

    return response.response || '';
  } catch (error) {
    console.error('Overall summary error:', error);
    return '';
  }
}

async function sendSearchResultsIndividually(
  chatId: number,
  query: string,
  results: any[],
  overallSummary: string,
  searchInfo: any,
  searchType: 'normal' | 'dork' = 'normal',
  searchContext: string = '',
  env: Environment
): Promise<void> {
  try {
    // Send header message
    const headerMessage = formatSearchHeader(query, searchInfo, searchType, searchContext);
    await sendMessage(chatId, headerMessage, env, true);
    
    // Small delay to ensure proper message order
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Send AI overview if available
    if (overallSummary) {
      const overviewMessage = formatAIOverview(overallSummary);
      await sendMessage(chatId, overviewMessage, env, true);
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    
    // Send each result individually
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const resultMessage = formatIndividualResult(result, i + 1);
      await sendMessage(chatId, resultMessage, env, true);
      
      // Small delay between results for better UX
      if (i < results.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    }
    
    // Send footer message with tips
    await new Promise(resolve => setTimeout(resolve, 300));
    const footerMessage = formatSearchFooter(searchType);
    await sendMessage(chatId, footerMessage, env, true);
    
  } catch (error) {
    console.error('Error sending individual results:', error);
    // Fallback to single message if individual sending fails
    const fallbackMessage = formatSearchResults(query, results, overallSummary, searchInfo, searchType, searchContext);
    await sendMessage(chatId, fallbackMessage, env, true);
  }
}

function formatSearchHeader(query: string, searchInfo: any, searchType: 'normal' | 'dork' = 'normal', searchContext: string = ''): string {
  const searchTypeIcon = searchType === 'dork' ? '🎯' : '🔍';
  const searchTypeText = searchType === 'dork' ? 'Google Dork' : 'Search';
  
  let message = `${searchTypeIcon} **${searchTypeText} Results for:**\n\`"${query}"\`\n\n`;
  
  if (searchType === 'dork' && searchContext) {
    message += `🔧 **Search Type:** ${searchContext}\n\n`;
  }
  
  message += `📊 **Search Stats:**\n`;
  message += `• Found ${searchInfo.totalResults} total results\n`;
  message += `• Search completed in ${searchInfo.searchTime} seconds\n`;
  message += `• Showing top 3 results with AI analysis\n\n`;
  message += `⬇️ **Results below:**`;
  
  return message;
}

function formatAIOverview(overallSummary: string): string {
  return `🤖 **AI Overview:**\n\n${overallSummary}\n\n📋 **Detailed Results:**`;
}

function formatIndividualResult(result: any, index: number): string {
  let message = `**📄 Result ${index}: ${result.title}**\n\n`;
  
  message += `🌐 **Source:** ${result.displayLink}\n\n`;
  
  message += `📝 **Description:**\n${result.snippet}\n\n`;
  
  if (result.aiSummary) {
    message += `🤖 **AI Insight:**\n*${result.aiSummary}*\n\n`;
  }
  
  message += `🔗 **[Read Full Article](${result.link})**`;
  
  return message;
}

function formatSearchFooter(searchType: 'normal' | 'dork' = 'normal'): string {
  let message = `✅ **Search Complete!**\n\n`;
  
  if (searchType === 'dork') {
    message += `💡 **Tips:**\n`;
    message += `• Try /examples for more Google Dork patterns\n`;
    message += `• Use /dork for operator reference\n`;
    message += `• Combine multiple operators for precise results\n\n`;
    message += `🔍 Ready for your next advanced search!`;
  } else {
    message += `💡 **Tips:**\n`;
    message += `• Use Google Dork operators for specific searches\n`;
    message += `• Try /dork to learn advanced search techniques\n`;
    message += `• Ask me anything else or refine your search\n\n`;
    message += `🔍 Ready for your next search!`;
  }
  
  return message;
}

async function sendMessage(chatId: number, text: string, env: Environment, parseMarkdown: boolean = false): Promise<void> {
  const telegramUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  
  const payload: any = {
    chat_id: chatId,
    text: text,
    disable_web_page_preview: true
  };
  
  if (parseMarkdown) {
    payload.parse_mode = 'Markdown';
  }
  
  await fetch(telegramUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
}

async function handleSetup(env: Environment): Promise<Response> {
  try {
    // Set webhook URL - replace YOUR_WORKER_URL with your actual Cloudflare Worker URL
    const webhookUrl = 'https://YOUR_WORKER_URL.workers.dev/webhook';
    const telegramUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`;
    
    const response = await fetch(telegramUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: webhookUrl
      })
    });
    
    const result = await response.json();
    
    return new Response(JSON.stringify({
      success: true,
      webhook_set: result,
      message: 'Bot setup complete! Your AI Search Engine bot is ready.'
    }, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

function getWelcomeMessage(): string {
  return `🤖 **Welcome to AI Search Engine Bot!**

I'm your intelligent search assistant powered by Google Search, Google Dorks, and Cloudflare AI.

✨ **What I can do:**
• 🔍 Regular web search with Google's powerful engine
• 🎯 Advanced Google Dork searches for specific results
• 🤖 AI-powered analysis of all search results
• 📊 Show you the top 3 most relevant results
• 💡 Provide insights and summaries for each result

**How to use:**
Just type your search query and I'll automatically detect if it's a Google Dork or regular search!

**Regular Search Examples:**
• "Latest AI developments 2024"
• "Best programming languages for beginners"
• "Climate change solutions"

**Google Dork Examples:**
• \`site:github.com machine learning\`
• \`filetype:pdf cybersecurity\`
• "password reset" site:company.com

**Commands:**
• /help - Detailed help
• /dork - Google Dork guide
• /examples - More Dork examples

Ready to search! 🚀`;
}

function getHelpMessage(): string {
  return `🔧 **AI Search Engine Bot Help**

**Commands:**
• /start - Show welcome message
• /help - Show this help message
• /dork - Google Dork operators guide
• /examples - Google Dork search examples

**Search Types:**

🔍 **Regular Search:**
Simply type any search query
• "Machine learning tutorials for beginners"
• "Best restaurants in Tokyo"
• "Latest news about renewable energy"

🎯 **Google Dork Search:**
I automatically detect advanced operators!
• \`site:reddit.com programming tips\`
• \`filetype:pdf "data science"\`
• \`intitle:"admin panel" inurl:login\`

**Features:**
🔍 **Smart Search** - Powered by Google Custom Search
🎯 **Google Dork Support** - Advanced search operators
🤖 **AI Analysis** - Each result gets AI-powered insights
📊 **Top Results** - Shows 3 most relevant results
🌐 **Rich Information** - Titles, snippets, and links
💡 **Context-Aware** - AI understands search context

**Auto-Detection:**
I automatically detect if your query uses Google Dork operators and provide specialized analysis!

Happy searching! 🚀`;
}

function getDorkHelpMessage(): string {
  return `🎯 **Google Dork Operators Guide**

**Site & Domain:**
• \`site:example.com\` - Search within specific site
• \`site:*.edu\` - Search all .edu domains
• \`-site:example.com\` - Exclude specific site

**File Types:**
• \`filetype:pdf\` - Find PDF files
• \`ext:docx\` - Find Word documents
• \`filetype:xls OR filetype:xlsx\` - Excel files

**Content Location:**
• \`intitle:"error"\` - Find pages with "error" in title
• \`inurl:admin\` - Pages with "admin" in URL
• \`intext:password\` - Pages containing "password"
• \`inanchor:"click here"\` - Links with specific anchor text

**Exact Phrases:**
• \`"exact phrase here"\` - Search for exact phrase
• \`"admin panel" site:company.com\` - Combine operators

**Advanced Operators:**
• \`allintitle:admin panel login\` - All words in title
• \`allinurl:admin login\` - All words in URL
• \`allintext:username password\` - All words in content

**Logic & Exclusion:**
• \`term1 OR term2\` - Either term
• \`term1 AND term2\` - Both terms
• \`-unwanted\` - Exclude term
• \`+required\` - Require term

**Wildcards & Ranges:**
• \`* security\` - Wildcard matching
• \`"admin * panel"\` - Wildcard in phrase
• \`price $100..$500\` - Number ranges

Type /examples for practical examples!`;
}

function getDorkExamplesMessage(): string {
  return `📚 **Google Dork Examples**

**Security Research:**
• \`intitle:"index of" password\`
• \`filetype:log inurl:"/logs/"\`
• \`site:pastebin.com "password"\`
• \`inurl:admin intitle:login\`

**File Discovery:**
• \`filetype:pdf site:company.com confidential\`
• \`ext:xlsx "employee" OR "salary"\`
• \`filetype:doc site:*.gov "classified"\`
• \`inurl:upload filetype:php\`

**Social Media Intelligence:**
• \`site:twitter.com "CEO announces"\`
• \`site:linkedin.com "data scientist" "hiring"\`
• \`site:reddit.com cryptocurrency 2024\`

**Technical Research:**
• \`site:stackoverflow.com "machine learning" python\`
• \`site:github.com "API key" language:python\`
• \`intitle:"swagger" inurl:api\`
• \`site:*.edu filetype:pdf "research paper"\`

**Business Intelligence:**
• \`"quarterly report" filetype:pdf site:*.com\`
• \`intitle:"company presentation" filetype:ppt\`
• \`site:crunchbase.com "startup funding"\`

**Academic Research:**
• \`site:scholar.google.com "climate change" 2024\`
• \`filetype:pdf "peer reviewed" machine learning\`
• \`site:*.edu "research methodology"\`

**News & Trends:**
• \`site:news.google.com "breaking news" today\`
• \`intitle:"press release" 2024\`
• \`site:*.com "market analysis" filetype:pdf\`

**Combine Multiple Operators:**
• \`site:reddit.com OR site:stackoverflow.com "python tips"\`
• \`intitle:"data breach" -site:wikipedia.org 2024\`
• \`"machine learning" (site:medium.com OR site:towardsdatascience.com)\`

Just type any of these examples and I'll execute the search with AI analysis! 🚀`;
}

// Export types for better TypeScript support
export { Environment, TelegramUpdate, GoogleSearchResult };
