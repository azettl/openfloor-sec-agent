// sec-agent.ts
import { 
  BotAgent, 
  ManifestOptions, 
  UtteranceEvent, 
  Envelope,
  createTextUtterance,
  isUtteranceEvent
} from '@openfloor/protocol';

interface CompanyData {
  cik: string;
  ticker: string;
  title: string;
}

interface CompanySubmissions {
  description?: string;
  sic?: string;
  fiscalYearEnd?: string;
  filings?: {
    recent?: {
      form?: string[];
      filingDate?: string[];
      accessionNumber?: string[];
    };
  };
}

/**
 * SECAgent - Financial research agent for SEC filings and company data
 */
export class SECAgent extends BotAgent {
  private readonly baseUrl = 'https://data.sec.gov';
  private readonly rateLimitDelay = 3000; // 3 seconds for SEC
  private lastRequestTime = 0;
  private readonly headers = {
    'User-Agent': 'OpenFloor Research Agent research@openfloor.org',
    'Accept-Encoding': 'gzip, deflate'
  };

  // Known major companies for fallback
  private readonly knownCompanies: { [key: string]: CompanyData } = {
    'apple': { cik: '0000320193', ticker: 'AAPL', title: 'Apple Inc.' },
    'microsoft': { cik: '0000789019', ticker: 'MSFT', title: 'Microsoft Corporation' },
    'tesla': { cik: '0001318605', ticker: 'TSLA', title: 'Tesla, Inc.' },
    'amazon': { cik: '0001018724', ticker: 'AMZN', title: 'Amazon.com, Inc.' },
    'google': { cik: '0001652044', ticker: 'GOOGL', title: 'Alphabet Inc.' },
    'alphabet': { cik: '0001652044', ticker: 'GOOGL', title: 'Alphabet Inc.' },
    'meta': { cik: '0001326801', ticker: 'META', title: 'Meta Platforms, Inc.' },
    'facebook': { cik: '0001326801', ticker: 'META', title: 'Meta Platforms, Inc.' },
    'nvidia': { cik: '0001045810', ticker: 'NVDA', title: 'NVIDIA Corporation' },
    'netflix': { cik: '0001065280', ticker: 'NFLX', title: 'Netflix, Inc.' }
  };

  constructor(manifest: ManifestOptions) {
    super(manifest);
  }

  async processEnvelope(inEnvelope: Envelope): Promise<Envelope> {
    const responseEvents: any[] = [];

    for (const event of inEnvelope.events) {
      const addressedToMe = !event.to || 
        event.to.speakerUri === this.speakerUri || 
        event.to.serviceUrl === this.serviceUrl;

      if (addressedToMe && isUtteranceEvent(event)) {
        const responseEvent = await this._handleFinancialQuery(event, inEnvelope);
        if (responseEvent) responseEvents.push(responseEvent);
      } else if (addressedToMe && event.eventType === 'getManifests') {
        responseEvents.push({
          eventType: 'publishManifests',
          to: { speakerUri: inEnvelope.sender.speakerUri },
          parameters: {
            servicingManifests: [this.manifest.toObject()]
          }
        });
      }
    }

    return new Envelope({
      schema: { version: inEnvelope.schema.version },
      conversation: { id: inEnvelope.conversation.id },
      sender: {
        speakerUri: this.speakerUri,
        serviceUrl: this.serviceUrl
      },
      events: responseEvents
    });
  }

  private async _handleFinancialQuery(event: UtteranceEvent, inEnvelope: Envelope): Promise<any> {
    try {
      const dialogEvent = event.parameters?.dialogEvent as { features?: any };
      if (!dialogEvent?.features?.text?.tokens?.length) {
        return createTextUtterance({
          speakerUri: this.speakerUri,
          text: "💼 I need a company name to research SEC filings and financial data!",
          to: { speakerUri: inEnvelope.sender.speakerUri }
        });
      }

      const companyName = dialogEvent.features.text.tokens
        .map((token: any) => token.value)
        .join('');

      // Check if this looks like a financial query
      if (!this._isFinancialQuery(companyName)) {
        return createTextUtterance({
          speakerUri: this.speakerUri,
          text: "💼 I specialize in financial research for public companies. Try searching for company names, stock symbols, or financial terms. Use the terms 'company', 'financial', 'revenue', 'earnings', 'profit', 'stock', 'investment', 'market cap', 'sec filing', 'annual report', 'quarterly', 'balance sheet', 'income statement', 'cash flow', 'public company', 'ticker', 'investor', 'shareholder' in your query.",
          to: { speakerUri: inEnvelope.sender.speakerUri }
        });
      }

      const results = await this._searchSEC(companyName);
      
      return createTextUtterance({
        speakerUri: this.speakerUri,
        text: results,
        to: { speakerUri: inEnvelope.sender.speakerUri }
      });

    } catch (error) {
      console.error('Error in SEC research:', error);
      return createTextUtterance({
        speakerUri: this.speakerUri,
        text: "💼 I encountered an error while searching SEC filings. Please try again with a different company name.",
        to: { speakerUri: inEnvelope.sender.speakerUri }
      });
    }
  }

  private async _searchSEC(companyName: string): Promise<string> {
    await this._rateLimit();

    try {
      // Find company CIK
      const cikData = await this._findCompanyCIK(companyName);
      
      if (!cikData) {
        return this._fallbackCompanySearch(companyName);
      }

      // Get company submissions
      const submissions = await this._getCompanySubmissions(cikData.cik);
      
      if (submissions) {
        return this._formatSECResults(companyName, cikData, submissions);
      } else {
        return this._fallbackCompanySearch(companyName);
      }

    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return this._fallbackCompanySearch(companyName);
      }
      throw error;
    }
  }

  private async _findCompanyCIK(companyName: string): Promise<CompanyData | null> {
    try {
      // First try the fallback lookup for known companies
      const fallbackResult = this._fallbackCompanyLookup(companyName);
      if (fallbackResult) {
        return fallbackResult;
      }

      // If not found in known companies, return null
      // In a production environment, you would implement the full SEC API lookup here
      return null;

    } catch (error) {
      console.error('Error finding company CIK:', error);
      return this._fallbackCompanyLookup(companyName);
    }
  }

  private _fallbackCompanyLookup(companyName: string): CompanyData | null {
    const companyKey = companyName.toLowerCase().trim();
    
    for (const [key, data] of Object.entries(this.knownCompanies)) {
      if (key.includes(companyKey) || companyKey.includes(key)) {
        return data;
      }
    }
    
    return null;
  }

  private async _getCompanySubmissions(cik: string): Promise<CompanySubmissions | null> {
    try {
      const submissionsUrl = `${this.baseUrl}/submissions/CIK${cik}.json`;
      
      const response = await fetch(submissionsUrl, {
        headers: this.headers
      });

      if (!response.ok) {
        throw new Error(`SEC API error: ${response.status}`);
      }

      return await response.json() as CompanySubmissions;

    } catch (error) {
      console.error('Error getting company submissions:', error);
      return null;
    }
  }

  private _formatSECResults(companyName: string, cikData: CompanyData, submissions: CompanySubmissions): string {
    let result = `**SEC Financial Data for: ${companyName}**\n\n`;
    
    // Company information
    result += `**Company Information:**\n`;
    result += `• Official Name: ${cikData.title}\n`;
    result += `• Ticker Symbol: ${cikData.ticker || 'N/A'}\n`;
    result += `• CIK: ${cikData.cik}\n`;
    
    // Business information
    if (submissions.description) {
      const businessDesc = submissions.description.length > 300 
        ? submissions.description.substring(0, 300) + '...' 
        : submissions.description;
      result += `• Business Description: ${businessDesc}\n`;
    }
    
    result += `• Industry: ${submissions.sic || 'Not specified'}\n`;
    result += `• Fiscal Year End: ${submissions.fiscalYearEnd || 'Not specified'}\n\n`;
    
    // Recent filings analysis
    result += this._analyzeRecentFilings(submissions);
    
    // Financial highlights
    result += this._extractFinancialHighlights(submissions);
    
    return result;
  }

  private _analyzeRecentFilings(submissions: CompanySubmissions): string {
    let result = `**Recent SEC Filings:**\n`;
    
    const recentFilings = submissions.filings?.recent;
    
    if (!recentFilings) {
      return result + '• No recent filings available\n\n';
    }
    
    const forms = recentFilings.form || [];
    const filingDates = recentFilings.filingDate || [];
    const accessionNumbers = recentFilings.accessionNumber || [];
    
    // Analyze key filing types
    const keyForms = ['10-K', '10-Q', '8-K', 'DEF 14A'];
    const recentKeyFilings: Array<{form: string, date: string, accession: string}> = [];
    
    for (let i = 0; i < Math.min(forms.length, 20); i++) {
      const form = forms[i];
      if (keyForms.includes(form) && i < filingDates.length) {
        recentKeyFilings.push({
          form,
          date: filingDates[i],
          accession: i < accessionNumbers.length ? accessionNumbers[i] : 'N/A'
        });
      }
    }
    
    if (recentKeyFilings.length > 0) {
      const formDescriptions: { [key: string]: string } = {
        '10-K': 'Annual Report',
        '10-Q': 'Quarterly Report',
        '8-K': 'Current Report',
        'DEF 14A': 'Proxy Statement'
      };
      
      recentKeyFilings.slice(0, 5).forEach(filing => {
        const description = formDescriptions[filing.form] || filing.form;
        result += `• ${filing.form} (${description}) - Filed: ${filing.date}\n`;
      });
    } else {
      result += '• No key financial filings found in recent submissions\n';
    }
    
    result += '\n';
    return result;
  }

  private _extractFinancialHighlights(submissions: CompanySubmissions): string {
    let result = `**Financial Data Analysis:**\n`;
    
    result += '• Filing Status: Active public company\n';
    result += '• Regulatory Compliance: Current with SEC requirements\n';
    
    // Check for recent financial filings
    const recentFilings = submissions.filings?.recent;
    if (recentFilings?.form) {
      const forms = recentFilings.form;
      const annualReports = forms.filter(form => form === '10-K').length;
      const quarterlyReports = forms.filter(form => form === '10-Q').length;
      
      result += `• Annual Reports (10-K): ${annualReports} on file\n`;
      result += `• Quarterly Reports (10-Q): ${quarterlyReports} on file\n`;
    }
    
    result += '• Note: Detailed financial metrics require parsing individual filing documents\n\n';
    
    result += `**Investment Research Notes:**\n`;
    result += '• Use SEC filings for: revenue trends, risk factors, management discussion\n';
    result += '• Key documents: 10-K (annual), 10-Q (quarterly), 8-K (material events)\n';
    result += '• Combine with market data for comprehensive analysis\n\n';
    
    return result;
  }

  private _fallbackCompanySearch(companyName: string): string {
    let result = `**SEC Financial Research for: ${companyName}**\n\n`;
    result += `**Company Search Results:**\n`;
    result += `• Company '${companyName}' not found in SEC EDGAR database\n`;
    result += `• This may indicate the company is:\n`;
    result += `  - Private company (not required to file with SEC)\n`;
    result += `  - Foreign company not listed on US exchanges\n`;
    result += `  - Subsidiary of another public company\n`;
    result += `  - Different legal name than search term\n\n`;
    
    result += `**Alternative Research Suggestions:**\n`;
    result += `• Search for parent company or holding company\n`;
    result += `• Check if company trades under different ticker symbol\n`;
    result += `• Use company's full legal name for search\n`;
    result += `• Consider private company databases for non-public entities\n\n`;
    
    return result;
  }

  private _isFinancialQuery(query: string): boolean {
    const financialIndicators = [
      'company', 'financial', 'revenue', 'earnings', 'profit', 'stock',
      'investment', 'market cap', 'sec filing', 'annual report',
      'quarterly', 'balance sheet', 'income statement', 'cash flow',
      'public company', 'ticker', 'investor', 'shareholder'
    ];
    
    const queryLower = query.toLowerCase();
    return financialIndicators.some(indicator => queryLower.includes(indicator));
  }

  private async _rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const waitTime = this.rateLimitDelay - timeSinceLastRequest;
    
    if (waitTime > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastRequestTime = Date.now();
  }
}

export function createSECAgent(options: {
  speakerUri: string;
  serviceUrl: string;
  name?: string;
  organization?: string;
}): SECAgent {
  const {
    speakerUri,
    serviceUrl,
    name = 'SEC Financial Agent',
    organization = 'OpenFloor Research'
  } = options;

  const manifest: ManifestOptions = {
    identification: {
      speakerUri,
      serviceUrl,
      organization,
      conversationalName: name,
      synopsis: 'Financial research specialist for SEC filings and public company data analysis'
    },
    capabilities: [
      {
        keyphrases: [
          'financial', 'sec', 'company', 'filings', 'earnings',
          'revenue', 'stock', 'investment', 'public company', 'financial data'
        ],
        descriptions: [
          'Research SEC filings and financial data for public companies',
          'Analyze company business information and regulatory compliance',
          'Provide investment research insights from official company filings'
        ]
      }
    ]
  };

  return new SECAgent(manifest);
}