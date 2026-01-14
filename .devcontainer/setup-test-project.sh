#!/bin/bash
set -e

echo "Setting up test project for sfp development..."

# Create test project directory
TEST_PROJECT_DIR="/workspaces/sfp-test-project"

if [ -f "$TEST_PROJECT_DIR/sfdx-project.json" ]; then
    echo "Test project already exists at $TEST_PROJECT_DIR"
    exit 0
fi

# Ensure proper ownership of the volume
echo "Setting up permissions..."
sudo chown -R $(whoami):$(whoami) "$TEST_PROJECT_DIR"

cd /workspaces

# Create project using Salesforce CLI
echo "Creating Salesforce project..."
sf project generate --name sfp-test-project --template standard

cd "$TEST_PROJECT_DIR"
