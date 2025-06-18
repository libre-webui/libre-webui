#!/bin/bash

# TypeScript Lint Fix Script for libre-webui
# This script fixes common TypeScript linting issues

set -e

echo "🔧 Starting TypeScript lint fixes..."

# Function to replace 'any' with 'unknown' in catch blocks and error handling
fix_error_handling() {
    echo "  📝 Fixing error handling..."
    
    # Fix catch (error: any) to catch (error: unknown)
    find frontend/src backend/src -name "*.ts" -o -name "*.tsx" | xargs sed -i.bak 's/catch (error: any)/catch (error: unknown)/g'
    find frontend/src backend/src -name "*.ts" -o -name "*.tsx" | xargs sed -i.bak 's/catch(error: any)/catch(error: unknown)/g'
    
    # Fix } catch (error: any) {
    find frontend/src backend/src -name "*.ts" -o -name "*.tsx" | xargs sed -i.bak 's/} catch (error: any) {/} catch (error: unknown) {/g'
    
    # Remove backup files
    find frontend/src backend/src -name "*.bak" -delete
}

# Function to remove unused variables
remove_unused_vars() {
    echo "  🗑️  Removing common unused variables..."
    
    # Fix unused variables in function parameters by prefixing with underscore
    find frontend/src backend/src -name "*.ts" -o -name "*.tsx" | while read file; do
        # Fix unused 'next' parameters in middleware
        sed -i.bak 's/, next)/, _next)/g' "$file"
        sed -i.bak 's/(req, res, next)/(req, res, _next)/g' "$file"
        
        # Fix unused 'error' and 'err' variables
        sed -i.bak 's/} catch (error) {/} catch (_error) {/g' "$file"
        sed -i.bak 's/} catch (err) {/} catch (_err) {/g' "$file"
        sed -i.bak 's/.catch(error =>/.catch(_error =>/g' "$file"
        sed -i.bak 's/.catch(err =>/.catch(_err =>/g' "$file"
    done
    
    # Remove backup files
    find frontend/src backend/src -name "*.bak" -delete
}

# Function to add eslint disable comments for remaining complex any types
add_eslint_disables() {
    echo "  ⚠️  Adding eslint-disable comments for complex cases..."
    
    # This will be handled manually for specific cases that are too complex to auto-fix
    echo "  ℹ️  Manual fixes still needed for complex type definitions"
}

# Run the fixes
echo "🎯 Running automated fixes..."

fix_error_handling
remove_unused_vars
add_eslint_disables

echo ""
echo "✅ Automated fixes completed!"
echo ""
echo "📊 Checking results..."

# Run linters to show progress
echo "Frontend lint results:"
cd frontend && npm run lint --silent 2>/dev/null | grep -E "(warning|error)" | wc -l | tr -d ' ' | xargs -I {} echo "  {} warnings remaining"
cd ..

echo "Backend lint results:"
cd backend && npm run lint --silent 2>/dev/null | grep -E "(warning|error)" | wc -l | tr -d ' ' | xargs -I {} echo "  {} warnings remaining"
cd ..

echo ""
echo "🎉 TypeScript lint fix script completed!"
echo "💡 Run 'npm run lint' to see detailed remaining issues"
