#!/bin/bash

# Universal script to update all AI provider plugins
# Usage: ./update-all-models.sh

echo "🤖 Universal AI Model Updater"
echo "================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to check if API key is set
check_api_key() {
    local provider=$1
    local var_name=$2
    local key_value=$(eval echo \$$var_name)
    
    if [ -z "$key_value" ]; then
        echo -e "${YELLOW}⚠️  $provider: API key not set (${var_name})${NC}"
        return 1
    else
        echo -e "${GREEN}✅ $provider: API key found${NC}"
        return 0
    fi
}

# Function to update a provider
update_provider() {
    local provider=$1
    local script_name=$2
    
    echo -e "\n${BLUE}🔄 Updating $provider models...${NC}"
    
    if [ -f "scripts/$script_name" ]; then
        if ./scripts/$script_name; then
            echo -e "${GREEN}✅ $provider: Successfully updated${NC}"
        else
            echo -e "${RED}❌ $provider: Update failed${NC}"
        fi
    else
        echo -e "${RED}❌ $provider: Update script not found (scripts/$script_name)${NC}"
    fi
}

echo -e "\n${BLUE}📋 Checking API keys...${NC}"

# Check API keys
openai_key_set=false
anthropic_key_set=false
groq_key_set=false

if check_api_key "OpenAI" "OPENAI_API_KEY"; then
    openai_key_set=true
fi

if check_api_key "Anthropic" "ANTHROPIC_API_KEY"; then
    anthropic_key_set=true
fi

if check_api_key "Groq" "GROQ_API_KEY"; then
    groq_key_set=true
fi

echo -e "\n${BLUE}🚀 Starting updates...${NC}"

# Update providers that have API keys set
if [ "$openai_key_set" = true ]; then
    update_provider "OpenAI" "update-openai-models.sh"
else
    echo -e "\n${YELLOW}⏭️  Skipping OpenAI (no API key)${NC}"
fi

if [ "$anthropic_key_set" = true ]; then
    update_provider "Anthropic" "update-anthropic-models.sh"
else
    echo -e "\n${YELLOW}⏭️  Skipping Anthropic (no API key)${NC}"
fi

# Groq doesn't need an update script since they don't have a models API endpoint
# But we can check if the key is set for future use
if [ "$groq_key_set" = true ]; then
    echo -e "\n${BLUE}ℹ️  Groq: Models are manually maintained (no API endpoint for listing)${NC}"
else
    echo -e "\n${YELLOW}⏭️  Groq API key not set${NC}"
fi

echo -e "\n${GREEN}🎉 Update process completed!${NC}"
echo -e "\n${BLUE}💡 Tip: Set your API keys as environment variables:${NC}"
echo -e "   export OPENAI_API_KEY=\"your_openai_key\""
echo -e "   export ANTHROPIC_API_KEY=\"your_anthropic_key\""
echo -e "   export GROQ_API_KEY=\"your_groq_key\""

echo -e "\n${BLUE}📁 Updated plugin files:${NC}"
ls -la plugins/*.json | awk '{print "   " $9 " (" $5 " bytes, " $6 " " $7 " " $8 ")"}'
