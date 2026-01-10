/**
 * Enrichment API Functions
 *
 * These functions call external enrichment APIs (PDL, Hunter, Apollo, Apify, Perplexity)
 * Each function handles its own error handling and returns a standardized response.
 */

import { supabase, DEFAULT_TEAM_ID } from './supabase.js';

// ============================================================================
// CREDENTIAL MANAGEMENT
// ============================================================================

async function getCredentials(integrationName) {
  // Build query - handle teamless mode
  let query = supabase
    .from('integrations')
    .select('credentials')
    .eq('name', integrationName)
    .eq('is_enabled', true);

  // Only filter by team_id if we have one
  if (DEFAULT_TEAM_ID) {
    query = query.eq('team_id', DEFAULT_TEAM_ID);
  } else {
    query = query.is('team_id', null);
  }

  const { data, error } = await query.single();

  if (error || !data) {
    throw new Error(`No active ${integrationName} integration found. Please configure API credentials.`);
  }

  return data.credentials;
}

// ============================================================================
// RATE LIMITING
// ============================================================================

async function checkRateLimit(integrationName) {
  // Skip rate limiting in teamless mode
  if (!DEFAULT_TEAM_ID) return true;

  const { data, error } = await supabase.rpc('check_rate_limit', {
    p_team_id: DEFAULT_TEAM_ID,
    p_integration_name: integrationName
  });

  if (error) {
    console.error('Rate limit check failed:', error.message);
    return true; // Allow on error
  }

  return data;
}

async function incrementRateLimit(integrationName, isError = false) {
  // Skip rate limiting in teamless mode
  if (!DEFAULT_TEAM_ID) return;

  await supabase.rpc('increment_rate_limit', {
    p_team_id: DEFAULT_TEAM_ID,
    p_integration_name: integrationName,
    p_is_error: isError
  });
}

// ============================================================================
// PEOPLE DATA LABS (PDL)
// ============================================================================

/**
 * Enrich a person via People Data Labs
 * Primary use: Find work email from personal email
 *
 * @param {Object} params
 * @param {string} params.email - Email address
 * @param {string} params.first_name - First name
 * @param {string} params.last_name - Last name
 * @param {string} params.company - Company name (optional)
 * @param {string} params.linkedin_url - LinkedIn URL (optional)
 */
export async function enrich_person_pdl({ email, first_name, last_name, company, linkedin_url }) {
  const integrationName = 'peopledatalabs';

  // Check rate limit
  const canProceed = await checkRateLimit(integrationName);
  if (!canProceed) {
    return { success: false, error: 'Rate limit exceeded for People Data Labs', rate_limited: true };
  }

  try {
    const credentials = await getCredentials(integrationName);
    const apiKey = credentials.api_key;

    // Build request body - only include non-empty fields
    const body = {};
    if (email) body.email = email;
    if (first_name) body.first_name = first_name;
    if (last_name) body.last_name = last_name;
    if (company) body.company = company;
    if (linkedin_url) body.profile = linkedin_url;

    const response = await fetch('https://api.peopledatalabs.com/v5/person/enrich', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
      },
      body: JSON.stringify(body),
    });

    await incrementRateLimit(integrationName, !response.ok);

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `PDL API error: ${response.status} - ${errorText}`,
        status: response.status
      };
    }

    const data = await response.json();

    // Extract key fields - PDL returns false for hidden/paywalled data instead of arrays
    const personData = data.data || {};
    const workEmail = typeof personData.work_email === 'string' ? personData.work_email : null;
    const emails = Array.isArray(personData.emails) ? personData.emails : [];
    const personalEmails = Array.isArray(personData.personal_emails) ? personData.personal_emails : [];
    const phoneNumbers = Array.isArray(personData.phone_numbers) ? personData.phone_numbers : [];

    return {
      success: true,
      data: {
        work_email: workEmail || emails.find(e => e.type === 'professional')?.address || null,
        personal_email: personalEmails[0] || null,
        linkedin_url: typeof personData.linkedin_url === 'string' ? personData.linkedin_url : null,
        title: personData.job_title || null,
        company: personData.job_company_name || null,
        company_domain: personData.job_company_website || null,
        location: typeof personData.location_name === 'string' ? personData.location_name : null,
        phone: phoneNumbers[0] || null,
        industry: personData.industry || null,
        skills: Array.isArray(personData.skills) ? personData.skills : [],
      },
      raw: data,
    };
  } catch (error) {
    await incrementRateLimit(integrationName, true);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// HUNTER.IO
// ============================================================================

/**
 * Find email using Hunter.io
 *
 * @param {Object} params
 * @param {string} params.domain - Company domain
 * @param {string} params.first_name - First name
 * @param {string} params.last_name - Last name
 */
export async function find_email_hunter({ domain, first_name, last_name }) {
  const integrationName = 'hunter';

  const canProceed = await checkRateLimit(integrationName);
  if (!canProceed) {
    return { success: false, error: 'Rate limit exceeded for Hunter.io', rate_limited: true };
  }

  try {
    const credentials = await getCredentials(integrationName);
    const apiKey = credentials.api_key;

    const params = new URLSearchParams({
      domain,
      api_key: apiKey,
    });
    if (first_name) params.append('first_name', first_name);
    if (last_name) params.append('last_name', last_name);

    const response = await fetch(`https://api.hunter.io/v2/email-finder?${params}`);

    await incrementRateLimit(integrationName, !response.ok);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        success: false,
        error: `Hunter API error: ${response.status} - ${errorData.errors?.[0]?.details || 'Unknown error'}`,
        status: response.status
      };
    }

    const data = await response.json();

    return {
      success: true,
      data: {
        email: data.data?.email,
        score: data.data?.score,
        domain: data.data?.domain,
        first_name: data.data?.first_name,
        last_name: data.data?.last_name,
        position: data.data?.position,
        verification_status: data.data?.verification?.status,
      },
      raw: data,
    };
  } catch (error) {
    await incrementRateLimit(integrationName, true);
    return { success: false, error: error.message };
  }
}

/**
 * Verify email deliverability using Hunter.io
 *
 * @param {Object} params
 * @param {string} params.email - Email to verify
 */
export async function verify_email_hunter({ email }) {
  const integrationName = 'hunter';

  const canProceed = await checkRateLimit(integrationName);
  if (!canProceed) {
    return { success: false, error: 'Rate limit exceeded for Hunter.io', rate_limited: true };
  }

  try {
    const credentials = await getCredentials(integrationName);
    const apiKey = credentials.api_key;

    const params = new URLSearchParams({ email, api_key: apiKey });
    const response = await fetch(`https://api.hunter.io/v2/email-verifier?${params}`);

    await incrementRateLimit(integrationName, !response.ok);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        success: false,
        error: `Hunter API error: ${response.status}`,
        status: response.status
      };
    }

    const data = await response.json();

    return {
      success: true,
      data: {
        status: data.data?.status, // valid, invalid, accept_all, webmail, disposable, unknown
        score: data.data?.score,
        email: data.data?.email,
        mx_records: data.data?.mx_records,
        smtp_check: data.data?.smtp_check,
        is_disposable: data.data?.disposable,
        is_webmail: data.data?.webmail,
      },
      raw: data,
    };
  } catch (error) {
    await incrementRateLimit(integrationName, true);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// APOLLO.IO (DISABLED - requires paid subscription for API access)
// ============================================================================

/**
 * Enrich person via Apollo
 * NOTE: Apollo requires a paid subscription for API access. Currently disabled.
 *
 * @param {Object} params
 * @param {string} params.email - Email address
 * @param {string} params.first_name - First name
 * @param {string} params.last_name - Last name
 * @param {string} params.domain - Company domain
 */
export async function enrich_person_apollo({ email, first_name, last_name, domain }) {
  // Apollo API disabled - requires paid subscription
  return {
    success: false,
    error: 'Apollo API disabled - requires paid subscription',
    disabled: true
  };

}

/**
 * Enrich company/organization via Apollo
 * NOTE: Apollo requires a paid subscription for API access. Currently disabled.
 *
 * @param {Object} params
 * @param {string} params.domain - Company domain
 * @param {string} params.name - Company name (optional)
 */
export async function enrich_company_apollo({ domain, name }) {
  // Apollo API disabled - requires paid subscription
  return {
    success: false,
    error: 'Apollo API disabled - requires paid subscription',
    disabled: true
  };
}

// ============================================================================
// GENERECT (Email Finder - Pay per success)
// ============================================================================

/**
 * Find and validate work email using Generect
 * Takes first_name, last_name, domain and returns validated corporate email
 * Cost: $0.03 per valid email found
 *
 * @param {Object} params
 * @param {string} params.first_name - First name
 * @param {string} params.last_name - Last name
 * @param {string} params.domain - Company domain (required)
 */
export async function find_email_generect({ first_name, last_name, domain }) {
  const integrationName = 'generect';

  if (!domain) {
    return { success: false, error: 'Domain is required for Generect email finder' };
  }

  const canProceed = await checkRateLimit(integrationName);
  if (!canProceed) {
    return { success: false, error: 'Rate limit exceeded for Generect', rate_limited: true };
  }

  try {
    const credentials = await getCredentials(integrationName);
    const apiKey = credentials.api_key;

    const response = await fetch('https://api.generect.com/api/linkedin/email_finder/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${apiKey}`,
      },
      body: JSON.stringify([{
        first_name,
        last_name,
        domain,
      }]),
    });

    await incrementRateLimit(integrationName, !response.ok);

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Generect API error: ${response.status} - ${errorText}`,
        status: response.status
      };
    }

    const data = await response.json();
    const result = data[0]; // API returns array

    if (!result) {
      return { success: false, error: 'No result returned from Generect' };
    }

    // Check if email was found and is valid
    const isValid = result.result === 'valid' && result.exist === 'yes';

    return {
      success: isValid,
      data: {
        email: isValid ? result.valid_email : null,
        is_valid: isValid,
        result_status: result.result,
        exists: result.exist,
        catch_all: result.catch_all,
        email_format: result.email_format,
        mx_domain: result.mx_domain,
        source: result.source,
      },
      raw: result,
    };
  } catch (error) {
    await incrementRateLimit(integrationName, true);
    return { success: false, error: error.message };
  }
}

/**
 * Scrape LinkedIn profile posts via Apify
 * Uses actor: apimaestro~linkedin-profile-posts
 * Runs synchronously and returns dataset items directly
 *
 * @param {Object} params
 * @param {string} params.linkedin_url - LinkedIn profile URL or username
 * @param {number} params.limit - Max posts to retrieve (1-100, default 10). Lower = cheaper (~5c vs 50c).
 */
export async function scrape_linkedin_profile({ linkedin_url, limit = 10 }) {
  const integrationName = 'apify';
  const ACTOR_ID = 'apimaestro~linkedin-profile-posts';

  const canProceed = await checkRateLimit(integrationName);
  if (!canProceed) {
    return { success: false, error: 'Rate limit exceeded for Apify', rate_limited: true };
  }

  try {
    const credentials = await getCredentials(integrationName);
    const token = credentials.token;

    // Extract username from URL if full URL provided
    let username = linkedin_url;
    if (linkedin_url.includes('linkedin.com/in/')) {
      username = linkedin_url.split('linkedin.com/in/')[1].replace(/\/$/, '');
    }

    // Use the sync endpoint that returns dataset items directly
    // limit=10 (default) costs ~5c vs 50c for 100 posts
    const response = await fetch(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username,
          limit: Math.min(Math.max(limit, 1), 100), // Clamp 1-100
        }),
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Apify API error: ${response.status} - ${errorText}`,
        status: response.status
      };
    }

    const items = await response.json();
    const profile = items[0];

    if (!profile) {
      return { success: true, data: null, message: 'No profile data returned' };
    }

    return {
      success: true,
      data: {
        name: profile.name || profile.fullName,
        headline: profile.headline,
        summary: profile.summary || profile.about,
        location: profile.location,
        connections: profile.connections || profile.connectionsCount,
        profile_url: profile.profileUrl || profile.url || linkedin_url,
        profile_image: profile.profilePicture || profile.profilePictureUrl,
        experience: profile.experience?.map(exp => ({
          title: exp.title,
          company: exp.company || exp.companyName,
          duration: exp.duration,
          description: exp.description,
        })),
        education: profile.education?.map(edu => ({
          school: edu.school || edu.schoolName,
          degree: edu.degree,
          field: edu.field || edu.fieldOfStudy,
          dates: edu.dates,
        })),
        skills: profile.skills,
        certifications: profile.certifications,
        posts: profile.posts, // This actor also returns posts
      },
      raw: profile,
    };
  } catch (error) {
    await incrementRateLimit(integrationName, true);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// PERPLEXITY (Company Research)
// ============================================================================

/**
 * Research a company using Perplexity AI
 *
 * @param {Object} params
 * @param {string} params.company_name - Company name
 * @param {string} params.domain - Company domain (optional, helps with accuracy)
 * @param {string} params.depth - Research depth: "light" (3 results) or "deep" (10 results, full analysis)
 * @param {string[]} params.focus_areas - Areas to focus on (overrides depth defaults)
 */
export async function research_company_perplexity({ company_name, domain, depth = 'light', focus_areas = [] }) {
  const integrationName = 'perplexity';

  const canProceed = await checkRateLimit(integrationName);
  if (!canProceed) {
    return { success: false, error: 'Rate limit exceeded for Perplexity', rate_limited: true };
  }

  try {
    const credentials = await getCredentials(integrationName);
    const apiKey = credentials.api_key;

    // Depth-based defaults - controls cost/thoroughness
    const isDeep = depth === 'deep';
    const maxResults = isDeep ? 10 : 3;
    const defaultFocusAreas = isDeep
      ? ['company overview', 'recent news', 'funding rounds', 'competitors', 'key initiatives', 'leadership changes']
      : ['company overview'];

    // Build the search query
    let query = `${company_name}`;
    if (domain) query += ` (${domain})`;

    const areas = focus_areas.length > 0 ? focus_areas : defaultFocusAreas;
    query += ` - ${areas.join(', ')}`;

    const response = await fetch('https://api.perplexity.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        search_recency_filter: 'month', // Focus on recent info
      }),
    });

    await incrementRateLimit(integrationName, !response.ok);

    if (!response.ok) {
      return {
        success: false,
        error: `Perplexity API error: ${response.status}`,
        status: response.status
      };
    }

    const data = await response.json();

    return {
      success: true,
      data: {
        company_name,
        domain,
        depth,
        focus_areas: areas,
        results: data.results?.map(r => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          date: r.date,
        })) || [],
        result_count: data.results?.length || 0,
      },
      raw: data,
    };
  } catch (error) {
    await incrementRateLimit(integrationName, true);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export const enrichmentApis = {
  enrich_person_pdl,
  find_email_hunter,
  verify_email_hunter,
  enrich_person_apollo,
  enrich_company_apollo,
  scrape_linkedin_profile,
  research_company_perplexity,
  find_email_generect,
};

export default enrichmentApis;
