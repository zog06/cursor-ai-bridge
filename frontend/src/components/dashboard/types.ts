export interface Account {
  email: string;
  status: string;
  rateLimited: boolean;
  lastUsed?: string;
}

export interface AccountsData {
  total: number;
  available: number;
  rateLimited: number;
  invalid: number;
  details?: Account[];
}

export interface ServerData {
  status: string;
  accounts?: AccountsData;
  uptime: string;
  port: number;
}

export interface NgrokData {
  status: string;
  url: string | null;
}

export interface RequestData {
  id: string;
  method: string;
  path: string;
  status: string;
  timestamp: string;
  duration?: number;
  model?: string;
  stream?: boolean;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  tools?: {
    count: number;
    tokens: number;
    names: string[];
  };
}

export interface DashboardData {
  server: ServerData;
  apiKey: string;
  ngrok: NgrokData;
  requests: RequestData[];
}

// Account Limits Types
export interface ModelLimit {
  remaining: string;
  remainingFraction: number | null;
  resetTime: string | null;
}

export interface AccountLimit {
  email: string;
  status: string;
  error: string | null;
  limits: Record<string, ModelLimit | null>;
}

export interface AccountLimitsResponse {
  timestamp: string;
  totalAccounts: number;
  models: string[];
  accounts: AccountLimit[];
}
