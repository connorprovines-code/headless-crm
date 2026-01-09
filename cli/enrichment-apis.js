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
  const { data, error } = await supabase
    .from('integrations')
    .select('credentials')
    .eq('team_id', DEFAULT_TEAM_ID)
    .eq('integration_name', integrationName)
    .eq('is_active', true)
    .single();

  if (error || !data) {
    throw new Error(`No active ${integrationName} integration found. Please configure API credentials.`);
  }

  return data.credentials;
}

// ============================================================================
// RATE LIMITING
// ============================================================================

async function checkRateLimit(integrationName) {
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

    // Extract key fields
    return {
      success: true,
      data: {
        work_email: data.data?.work_email || data.data?.emails?.find(e => e.type === 'professional')?.address,
        personal_email: data.data?.personal_emails?.[0],
        linkedin_url: data.data?.linkedin_url,
        title: data.data?.job_title,
        company: data.data?.job_company_name,
        company_domain: data.data?.job_company_website,
        location: data.data?.location_name,
        phone: data.data?.phone_numbers?.[0],
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
// APOLLO.IO
// ============================================================================

/**
 * Enrich person via Apollo
 *
 * @param {Object} params
 * @param {string} params.email - Email address
 * @param {string} params.first_name - First name
 * @param {string} params.last_name - Last name
 * @param {string} params.domain - Company domain
 */
export async function enrich_person_apollo({ email, first_name, last_name, domain }) {
  const integrationName = 'apollo_enrichment';

  const canProceed = await checkRateLimit(integrationName);
  if (!canProceed) {
    return { success: false, error: 'Rate limit exceeded for Apollo', rate_limited: true };
  }

  try {
    const credentials = await getCredentials(integrationName);
    const apiKey = credentials.api_key;

    // Build query params for matching
    const params = new URLSearchParams();
    if (email) params.append('email', email);
    if (first_name) params.append('first_name', first_name);
    if (last_name) params.append('last_name', last_name);
    if (domain) params.append('domain', domain);

    const response = await fetch(`https://api.apollo.io/api/v1/people/match?${params}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
    });

    await incrementRateLimit(integrationName, !response.ok);

    if (!response.ok) {
      return {
        success: false,
        error: `Apollo API error: ${response.status}`,
        status: response.status
      };
    }

    const data = await response.json();
    const person = data.person;

    if (!person) {
      return { success: true, data: null, message: 'No match found' };
    }

    return {
      success: true,
      data: {
        id: person.id,
        first_name: person.first_name,
        last_name: person.last_name,
        name: person.name,
        title: person.title,
        headline: person.headline,
        email: person.email,
        email_status: person.email_status,
        linkedin_url: person.linkedin_url,
        twitter_url: person.twitter_url,
        github_url: person.github_url,
        photo_url: person.photo_url,
        city: person.city,
        state: person.state,
        country: person.country,
        seniority: person.seniority,
        departments: person.departments,
        employment_history: person.employment_history,
        organization: person.organization ? {
          id: person.organization.id,
          name: person.organization.name,
          domain: person.organization.primary_domain,
          industry: person.organization.industry,
          employee_count: person.organization.estimated_num_employees,
          founded_year: person.organization.founded_year,
        } : null,
      },
      raw: data,
    };
  } catch (error) {
    await incrementRateLimit(integrationName, true);
    return { success: false, error: error.message };
  }
}

/**
 * Enrich company/organization via Apollo
 *
 * @param {Object} params
 * @param {string} params.domain - Company domain
 * @param {string} params.name - Company name (optional)
 */
export async function enrich_company_apollo({ domain, name }) {
  const integrationName = 'apollo_enrichment';

  const canProceed = await checkRateLimit(integrationName);
  if (!canProceed) {
    return { success: false, error: 'Rate limit exceeded for Apollo', rate_limited: true };
  }

  try {
    const credentials = await getCredentials(integrationName);
    const apiKey = credentials.api_key;

    const params = new URLSearchParams();
    if (domain) params.append('domain', domain);
    if (name) params.append('name', name);

    const response = await fetch(`https://api.apollo.io/api/v1/organizations/enrich?${params}`, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
      },
    });

    await incrementRateLimit(integrationName, !response.ok);

    if (!response.ok) {
      return {
        success: false,
        error: `Apollo API error: ${response.status}`,
        status: response.status
      };
    }

    const data = await response.json();
    const org = data.organization;

    if (!org) {
      return { success: true, data: null, message: 'No match found' };
    }

    return {
      success: true,
      data: {
        id: org.id,
        name: org.name,
        domain: org.primary_domain,
        website_url: org.website_url,
        linkedin_url: org.linkedin_url,
        twitter_url: org.twitter_url,
        facebook_url: org.facebook_url,
        industry: org.industry,
        industries: org.industries,
        employee_count: org.estimated_num_employees,
        employee_range: org.employee_count,
        founded_year: org.founded_year,
        annual_revenue: org.annual_revenue,
        annual_revenue_printed: org.annual_revenue_printed,
        total_funding: org.total_funding,
        total_funding_printed: org.total_funding_printed,
        latest_funding_round_date: org.latest_funding_round_date,
        latest_funding_stage: org.latest_funding_stage,
        phone: org.phone,
        city: org.city,
        state: org.state,
        country: org.country,
        keywords: org.keywords,
        technologies: org.technologies,
        short_description: org.short_description,
        seo_description: org.seo_description,
      },
      raw: data,
    };
  } catch (error) {
    await incrementRateLimit(integrationName, true);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// APIFY (LinkedIn Scraping)
// ============================================================================

/**
 * Scrape LinkedIn profile via Apify
 * Uses actor: LQQIXN9Othf8f7R5n
 *
 * @param {Object} params
 * @param {string} params.linkedin_url - LinkedIn profile URL
 */
export async function scrape_linkedin_profile({ linkedin_url }) {
  const integrationName = 'apify';
  const ACTOR_ID = 'LQQIXN9Othf8f7R5n';

  const canProceed = await checkRateLimit(integrationName);
  if (!canProceed) {
    return { success: false, error: 'Rate limit exceeded for Apify', rate_limited: true };
  }

  try {
    const credentials = await getCredentials(integrationName);
    const token = credentials.token;

    // Start the actor run
    const runResponse = await fetch(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: linkedin_url,
        }),
      }
    );

    if (!runResponse.ok) {
      await incrementRateLimit(integrationName, true);
      return {
        success: false,
        error: `Apify API error: ${runResponse.status}`,
        status: runResponse.status
      };
    }

    const runData = await runResponse.json();
    const runId = runData.data?.id;

    if (!runId) {
      await incrementRateLimit(integrationName, true);
      return { success: false, error: 'Failed to start Apify actor' };
    }

    // Poll for completion (max 60 seconds)
    let attempts = 0;
    const maxAttempts = 30;
    let status = 'RUNNING';

    while (status === 'RUNNING' && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds

      const statusResponse = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${token}`
      );

      if (statusResponse.ok) {
        const statusData = await statusResponse.json();
        status = statusData.data?.status;
      }

      attempts++;
    }

    if (status !== 'SUCCEEDED') {
      await incrementRateLimit(integrationName, true);
      return {
        success: false,
        error: `Apify actor did not complete in time. Status: ${status}`,
        run_id: runId
      };
    }

    // Get the results
    const datasetResponse = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${token}`
    );

    await incrementRateLimit(integrationName, !datasetResponse.ok);

    if (!datasetResponse.ok) {
      return { success: false, error: 'Failed to fetch Apify results' };
    }

    const items = await datasetResponse.json();
    const profile = items[0];

    if (!profile) {
      return { success: true, data: null, message: 'No profile data returned' };
    }

    return {
      success: true,
      data: {
        name: profile.name,
        headline: profile.headline,
        summary: profile.summary,
        location: profile.location,
        connections: profile.connections,
        profile_url: profile.profileUrl || linkedin_url,
        profile_image: profile.profilePicture,
        experience: profile.experience?.map(exp => ({
          title: exp.title,
          company: exp.company,
          duration: exp.duration,
          description: exp.description,
        })),
        education: profile.education?.map(edu => ({
          school: edu.school,
          degree: edu.degree,
          field: edu.field,
          dates: edu.dates,
        })),
        skills: profile.skills,
        certifications: profile.certifications,
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
 * @param {string[]} params.focus_areas - Areas to focus on (e.g., ["recent_news", "competitors"])
 */
export async function research_company_perplexity({ company_name, domain, focus_areas = [] }) {
  const integrationName = 'perplexity';

  const canProceed = await checkRateLimit(integrationName);
  if (!canProceed) {
    return { success: false, error: 'Rate limit exceeded for Perplexity', rate_limited: true };
  }

  try {
    const credentials = await getCredentials(integrationName);
    const apiKey = credentials.api_key;

    // Build the search query
    let query = `${company_name}`;
    if (domain) query += ` (${domain})`;

    if (focus_areas.length > 0) {
      query += ` - ${focus_areas.join(', ')}`;
    } else {
      query += ' - company overview, recent news, key initiatives, competitive landscape';
    }

    const response = await fetch('https://api.perplexity.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: 10,
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
        focus_areas,
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
};

export default enrichmentApis;
