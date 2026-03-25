build:
	npx @vscode/vsce package --allow-missing-repository

install: build
	code --install-extension hunkwise-$$(node -p "require('./package.json').version").vsix --force
