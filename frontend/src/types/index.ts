export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  model?: string;
  images?: string[]; // Base64 encoded images for multimodal support
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  model: string;
  createdAt: number;
  updatedAt: number;
}

export interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
  details?: {
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface GenerationOptions {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  num_predict?: number;
  stop?: string[];
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface WebSocketMessage {
  type:
    | 'connected'
    | 'user_message'
    | 'assistant_chunk'
    | 'assistant_complete'
    | 'error';
  data: any;
}

export interface Theme {
  mode: 'light' | 'dark';
}

export interface UserPreferences {
  theme: Theme;
  defaultModel: string;
  systemMessage: string;
  generationOptions: GenerationOptions;
}
