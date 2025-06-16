import fs from 'fs';
import path from 'path';

export interface UserPreferences {
  defaultModel: string;
  theme: 'light' | 'dark';
  systemMessage: string;
  // Future preferences can be added here
}

class PreferencesService {
  private preferencesFile = path.join(process.cwd(), 'preferences.json');
  private defaultPreferences: UserPreferences = {
    defaultModel: '',
    theme: 'light',
    systemMessage: 'You are a helpful assistant.',
  };

  constructor() {
    this.ensurePreferencesFile();
  }

  private ensurePreferencesFile() {
    try {
      if (!fs.existsSync(this.preferencesFile)) {
        // Ensure the directory exists
        const dir = path.dirname(this.preferencesFile);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(
          this.preferencesFile,
          JSON.stringify(this.defaultPreferences, null, 2)
        );
        console.log('Created preferences.json with default settings');
      }
    } catch (error) {
      console.error('Failed to create preferences file:', error);
    }
  }

  getPreferences(): UserPreferences {
    try {
      if (fs.existsSync(this.preferencesFile)) {
        const data = fs.readFileSync(this.preferencesFile, 'utf8');
        const preferences = JSON.parse(data);
        // Merge with defaults to ensure all fields exist
        return { ...this.defaultPreferences, ...preferences };
      }
    } catch (error) {
      console.error('Failed to load preferences:', error);
    }
    return this.defaultPreferences;
  }

  updatePreferences(updates: Partial<UserPreferences>): UserPreferences {
    try {
      const currentPreferences = this.getPreferences();
      const updatedPreferences = { ...currentPreferences, ...updates };

      fs.writeFileSync(
        this.preferencesFile,
        JSON.stringify(updatedPreferences, null, 2)
      );
      console.log('Preferences updated:', updates);

      return updatedPreferences;
    } catch (error) {
      console.error('Failed to save preferences:', error);
      throw error;
    }
  }

  setDefaultModel(model: string): UserPreferences {
    return this.updatePreferences({ defaultModel: model });
  }

  setSystemMessage(message: string): UserPreferences {
    return this.updatePreferences({ systemMessage: message });
  }

  getDefaultModel(): string {
    return this.getPreferences().defaultModel;
  }

  getSystemMessage(): string {
    return this.getPreferences().systemMessage;
  }
}

export default new PreferencesService();
