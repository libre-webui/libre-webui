#!/bin/bash

# Update OpenRouter models plugin
# This script updates the OpenRouter plugin with the latest available models

echo "🤖 Updating OpenRouter models..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if API key is set
if [ -z "$OPENROUTER_API_KEY" ]; then
    echo -e "${RED}❌ Error: OPENROUTER_API_KEY environment variable not set${NC}"
    exit 1
fi

# Plugin file path
PLUGIN_FILE="plugins/openrouter.json"

# Backup existing plugin file
if [ -f "$PLUGIN_FILE" ]; then
    cp "$PLUGIN_FILE" "$PLUGIN_FILE.backup"
    echo -e "${BLUE}📋 Backed up existing plugin to $PLUGIN_FILE.backup${NC}"
fi

# Fetch models from OpenRouter API
echo -e "${BLUE}🔄 Fetching available models from OpenRouter API...${NC}"

# Get models and save to temporary file
TEMP_FILE=$(mktemp)
curl -s -H "Authorization: Bearer $OPENROUTER_API_KEY" "https://openrouter.ai/api/v1/models" | jq -r '.data[] | select(.architecture.modality == "text->text" or .architecture.modality == "text+image->text") | .id' | sort > "$TEMP_FILE"

# Check if we got models
if [ ! -s "$TEMP_FILE" ]; then
    echo -e "${RED}❌ No models found in API response${NC}"
    rm "$TEMP_FILE"
    exit 1
fi

# Count models
MODEL_COUNT=$(cat "$TEMP_FILE" | wc -l)
echo -e "${GREEN}✅ Found $MODEL_COUNT models${NC}"

# Create JSON array from the model list
MODEL_ARRAY=""
FIRST=true
while IFS= read -r model; do
    if [ "$FIRST" = true ]; then
        MODEL_ARRAY="\"$model\""
        FIRST=false
    else
        MODEL_ARRAY="$MODEL_ARRAY,\n  \"$model\""
    fi
done < "$TEMP_FILE"

# Clean up temp file
rm "$TEMP_FILE"

# Create updated plugin JSON
cat > "$PLUGIN_FILE" << EOF
{
  "id": "openrouter",
  "name": "OpenRouter",
  "type": "completion",
  "endpoint": "https://openrouter.ai/api/v1/chat/completions",
  "auth": {
    "header": "Authorization",
    "prefix": "Bearer ",
    "key_env": "OPENROUTER_API_KEY"
  },
  "model_map": [
  $(echo -e "$MODEL_ARRAY")
]
}
EOF

# Verify JSON is valid
if ! jq empty "$PLUGIN_FILE" 2>/dev/null; then
    echo -e "${RED}❌ Generated invalid JSON, restoring backup${NC}"
    if [ -f "$PLUGIN_FILE.backup" ]; then
        mv "$PLUGIN_FILE.backup" "$PLUGIN_FILE"
    fi
    exit 1
fi

echo -e "${GREEN}✅ Successfully updated OpenRouter plugin with $MODEL_COUNT models${NC}"
echo -e "${BLUE}📝 Plugin file: $PLUGIN_FILE${NC}"

# Show first few models as preview
echo -e "${YELLOW}📋 Preview of available models:${NC}"
head -10 <<< "$(jq -r '.model_map[]' "$PLUGIN_FILE")"
if [ $MODEL_COUNT -gt 10 ]; then
    echo "... and $((MODEL_COUNT - 10)) more"
fi

echo -e "${GREEN}🎉 OpenRouter models update complete!${NC}"
