import * as vscode from 'vscode'
import * as NodePath from 'path'
const KeyVditorOptions = 'vditor.options'

function debug(...args: any[]) {
  console.log(...args)
}

function showError(msg: string) {
  vscode.window.showErrorMessage(`[markdown-editor] ${msg}`)
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-editor.openEditor',
      (uri?: vscode.Uri, ...args) => {
        debug('command', uri, args)
        EditorPanel.createOrShow(context, uri)
      }
    )
  )

  // Register the custom editor provider only if the setting is enabled
  const config = vscode.workspace.getConfiguration('markdown-editor');
  const useAsDefault = config.get<boolean>('useAsDefault', false);
  
  if (useAsDefault) {
    const provider = new MarkdownEditorProvider(context);
    context.subscriptions.push(
      vscode.window.registerCustomEditorProvider('markdown-editor.editor', provider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false
      })
    );
  }
  
  // Listen for configuration changes to re-register the provider if needed
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('markdown-editor.useAsDefault')) {
        // Reload window to apply the change
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    })
  );

  context.globalState.setKeysForSync([KeyVditorOptions])
}

/**
 * Custom Editor Provider for Markdown files
 */
class MarkdownEditorProvider implements vscode.CustomEditorProvider<vscode.CustomDocument> {
  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<vscode.CustomDocument>>();
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  constructor(private context: vscode.ExtensionContext) {}

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // Log when editors are being resolved
    console.log(`Resolving custom editor for ${document.uri.toString()}`);
    
    try {
      // First, ensure the text document is open in the background
      const textDocument = await vscode.workspace.openTextDocument(document.uri);
      
      // Create a new editor panel using the existing webview panel
      const panel = await EditorPanelMap.createWithExistingPanel(this.context, textDocument, webviewPanel);
      
      // Add specific handling for panel disposal
      webviewPanel.onDidDispose(() => {
        console.log(`Webview panel disposed for ${document.uri.toString()}`);
        // Only clean up what's necessary, don't cascade to other resources
      });
    } catch (error) {
      console.error(`Error resolving custom editor: ${error}`);
      const errorMessage = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to open markdown editor: ${errorMessage}`);
      
      // Fall back to default editor
      webviewPanel.dispose();
      await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
    }
  }

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => {} };
  }

  // Implement required methods from the interface
  saveCustomDocument(document: vscode.CustomDocument, cancellation: vscode.CancellationToken): Thenable<void> {
    const panel = EditorPanelMap.get(document.uri);
    if (panel && panel._document) {
      return panel._document.save().then(() => {});
    }
    return Promise.resolve();
  }

  saveCustomDocumentAs(document: vscode.CustomDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Thenable<void> {
    // Fix: The saveAs method only takes one parameter and returns Uri | undefined
    // We need to use a different approach
    return vscode.workspace.openTextDocument(document.uri).then(doc => {
      return vscode.workspace.fs.writeFile(destination, Buffer.from(doc.getText())).then(() => {});
    });
  }

  revertCustomDocument(document: vscode.CustomDocument, cancellation: vscode.CancellationToken): Thenable<void> {
    return Promise.resolve();
  }

  backupCustomDocument(document: vscode.CustomDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Thenable<vscode.CustomDocumentBackup> {
    return Promise.resolve({
      id: context.destination.toString(),
      delete: () => {}
    });
  }
}

/**
 * Manages markdown editor webview panels
 */
class EditorPanelMap {
  /**
   * Track all active panels by URI
   */
  private static panels = new Map<string, EditorPanel>();

  /**
   * Get a panel by URI
   */
  public static get(uri: vscode.Uri): EditorPanel | undefined {
    return this.panels.get(uri.toString());
  }

  /**
   * Register a panel
   */
  public static register(uri: vscode.Uri, panel: EditorPanel): void {
    this.panels.set(uri.toString(), panel);
  }

  /**
   * Unregister a panel
   */
  public static unregister(uri: vscode.Uri): void {
    this.panels.delete(uri.toString());
  }

  /**
   * Create a new panel with an existing webview panel (for custom editor)
   */
  public static async createWithExistingPanel(
    context: vscode.ExtensionContext,
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<EditorPanel> {
    const uri = document.uri;
    const existingPanel = this.get(uri);
    
    if (existingPanel) {
      existingPanel.dispose();
    }
    
    // Configure the webview panel with our options
    webviewPanel.webview.options = EditorPanel.getWebviewOptions(uri);
    
    const panel = new EditorPanel(
      context,
      webviewPanel,
      context.extensionUri,
      document,
      uri
    );
    
    this.register(uri, panel);
    return panel;
  }

  /**
   * Create a new panel or show an existing one
   */
  public static async createOrShow(
    context: vscode.ExtensionContext,
    uri?: vscode.Uri
  ): Promise<EditorPanel | undefined> {
    const { extensionUri } = context;
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;
    
    // If we have a URI and an existing panel for it, show it
    if (uri) {
      const existingPanel = this.get(uri);
      if (existingPanel) {
        existingPanel._panel.reveal(column);
        return existingPanel;
      }
    }

    if (!vscode.window.activeTextEditor && !uri) {
      showError(`Did not open markdown file!`);
      return;
    }
    
    let doc: undefined | vscode.TextDocument;
    
    // from context menu : 从当前打开的 textEditor 中寻找 是否有当前 markdown 的 editor, 有的话则绑定 document
    if (uri) {
      // 从右键打开文件，先打开文档然后开启自动同步，不然没法保存文件和同步到已经打开的document
      doc = await vscode.workspace.openTextDocument(uri);
    } else {
      doc = vscode.window.activeTextEditor?.document;
      // from command mode
      if (doc && doc.languageId !== 'markdown') {
        showError(
          `Current file language is not markdown, got ${doc.languageId}`
        );
        return;
      }
    }

    if (!doc) {
      showError(`Cannot find markdown file!`);
      return;
    }

    // Create a new panel
    const panel = vscode.window.createWebviewPanel(
      EditorPanel.viewType,
      'markdown-editor',
      column || vscode.ViewColumn.One,
      EditorPanel.getWebviewOptions(uri)
    );

    const editorPanel = new EditorPanel(
      context,
      panel,
      extensionUri,
      doc,
      uri
    );
    
    this.register(doc.uri, editorPanel);
    return editorPanel;
  }
}

/**
 * Individual editor panel instance
 */
class EditorPanel {
  /**
   * Track the currently panel. Only allow a single panel to exist at a time.
   */
  public static readonly viewType = 'markdown-editor';
  // Add these properties at the top of the class
  private _textEditTimer: NodeJS.Timeout | null = null;
  private _disposalTimeout: NodeJS.Timeout | null = null;
  private _disposables: vscode.Disposable[] = [];

  public static async createOrShow(
    context: vscode.ExtensionContext,
    uri?: vscode.Uri
  ) {
    return EditorPanelMap.createOrShow(context, uri);
  }

  private static getFolders(): vscode.Uri[] {
    const data = [];
    for (let i = 65; i <= 90; i++) {
      data.push(vscode.Uri.file(`${String.fromCharCode(i)}:/`));
    }
    return data;
  }

  static getWebviewOptions(
    uri?: vscode.Uri
  ): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
      // Enable javascript in the webview
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file("/"), ...this.getFolders()],
      retainContextWhenHidden: true,
      enableCommandUris: true,
    };
  }
  
  private get _fsPath() {
    return this._uri.fsPath;
  }

  static get config() {
    return vscode.workspace.getConfiguration('markdown-editor');
  }

  // Replace the existing document close event handlers with this single implementation
  private setupDocumentCloseHandler() {
    let disposalTimeout: NodeJS.Timeout | null = null;
    
    vscode.workspace.onDidCloseTextDocument((e) => {
      console.log(`Document closed: ${e.fileName}, comparing with ${this._fsPath}`);
      
      if (e.fileName === this._fsPath) {
        console.log(`Scheduling disposal for panel for ${this._fsPath} due to document close`);
        
        // Clear any existing timeout
        if (disposalTimeout) {
          clearTimeout(disposalTimeout);
        }
        
        // Set a timeout to delay disposal
        const timeoutSeconds = EditorPanel.config.get<number>('disposalTimeoutSeconds', 10);
        disposalTimeout = setTimeout(() => {
          // Check if the document has been reopened
          const isDocumentOpen = vscode.workspace.textDocuments.some(
            doc => doc.fileName === this._fsPath
          );
          
          // Check if the panel is still visible
          const isPanelVisible = this._panel.visible;
          
          if (!isDocumentOpen && !isPanelVisible) {
            console.log(`Executing delayed disposal for ${this._fsPath} - document was not reopened after 10s`);
            this.dispose();
          } else {
            console.log(`Cancelling disposal for ${this._fsPath} - document was reopened or panel is visible`);
          }
        }, timeoutSeconds * 1000); // 10 second delay
      }
    }, this._disposables);
    
    // Cancel the disposal if the document is reopened
    vscode.workspace.onDidOpenTextDocument((e) => {
      console.log(`Document opened: ${e.fileName}`);
      if (e.fileName === this._fsPath && disposalTimeout) {
        console.log(`Cancelling scheduled disposal for ${this._fsPath} - document reopened`);
        clearTimeout(disposalTimeout);
        disposalTimeout = null;
      }
    }, this._disposables);
    
    // Also clear on panel disposal
    this._panel.onDidDispose(() => {
      if (disposalTimeout) {
        clearTimeout(disposalTimeout);
        disposalTimeout = null;
      }
    }, null, this._disposables);
  }

  // Add this flag to the EditorPanel class
  private _documentEditPending = false;

  // Replace the existing document change handler
  private setupDocumentChangeHandler() {
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.fileName !== this._document.fileName) {
        return;
      }
      
      // Skip if this change was triggered by our own edit
      if (this._documentEditPending) {
        return;
      }
      
      // Skip if webview panel is active (user is editing in the webview)
      if (this._panel.active) {
        return;
      }
      
      // Debounce updates
      if (this._textEditTimer) {
        clearTimeout(this._textEditTimer);
      }
      
      this._textEditTimer = setTimeout(() => {
        this._update();
        this._updateEditTitle();
      }, 300);
    }, this._disposables);
  }

  // Update the message handler for edit messages
  private async handleEditMessage(content: string) {
    if (!this._panel.active) {
      return; // Only sync when webview is active
    }
    
    try {
      this._documentEditPending = true;
      
      if (this._document) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          this._document.uri,
          new vscode.Range(0, 0, this._document.lineCount, 0),
          content
        );
        await vscode.workspace.applyEdit(edit);
      } else if (this._uri) {
        await vscode.workspace.fs.writeFile(this._uri, Buffer.from(content));
      } else {
        showError(`Cannot find original file to save!`);
      }
      
      this._updateEditTitle();
    } finally {
      this._documentEditPending = false;
    }
  }

  private async syncToEditor() {
    if (this._document) {
      const content = await this._panel.webview.postMessage({ command: 'getContent' });
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        this._document.uri,
        new vscode.Range(0, 0, this._document.lineCount, 0),
        String(content || '')
      );
      await vscode.workspace.applyEdit(edit);
    }
  }
  constructor(
    private readonly _context: vscode.ExtensionContext,
    public readonly _panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    public _document: vscode.TextDocument,
    public _uri = _document.uri
  ) {
    // Set the webview's initial html content
    console.log(`Creating EditorPanel for ${this._uri.toString()}`);

    this._init();
    
    // Set up our improved handlers
    this.setupDocumentCloseHandler();
    this.setupDocumentChangeHandler();
    
    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        debug('msg from webview review', message, this._panel.active);

        switch (message.command) {
          case 'ready':
            this._update({
              type: 'init',
              options: {
                useVscodeThemeColor: EditorPanel.config.get<boolean>(
                  'useVscodeThemeColor'
                ),
                ...this._context.globalState.get(KeyVditorOptions),
              },
              theme:
                vscode.window.activeColorTheme.kind ===
                vscode.ColorThemeKind.Dark
                  ? 'dark'
                  : 'light',
            });
            break;
          case 'save-options':
            this._context.globalState.update(KeyVditorOptions, message.options);
            break;
          case 'info':
            vscode.window.showInformationMessage(message.content);
            break;
          case 'error':
            showError(message.content);
            break;
          case 'edit':
            await this.handleEditMessage(message.content);
            break;
          case 'reset-config': {
            await this._context.globalState.update(KeyVditorOptions, {});
            break;
          }
          case 'save': {
            await this.syncToEditor();
            await this._document.save();
            this._updateEditTitle();
            break;
          }
          case 'upload': {
            const assetsFolder = EditorPanel.getAssetsFolder(this._uri);
            try {
              await vscode.workspace.fs.createDirectory(
                vscode.Uri.file(assetsFolder)
              );
            } catch (error) {
              console.error(error);
              showError(`Invalid image folder: ${assetsFolder}`);
            }
            await Promise.all(
              message.files.map(async (f: any) => {
                const content = Buffer.from(f.base64, 'base64');
                return vscode.workspace.fs.writeFile(
                  vscode.Uri.file(NodePath.join(assetsFolder, f.name)),
                  content
                );
              })
            );
            const files = message.files.map((f: any) =>
              NodePath.relative(
                NodePath.dirname(this._fsPath),
                NodePath.join(assetsFolder, f.name)
              ).replace(/\\/g, '/')
            );
            this._panel.webview.postMessage({
              command: 'uploaded',
              files,
            });
            break;
          }
          case 'open-link': {
            let url = message.href;
            if (!/^http/.test(url)) {
              url = NodePath.resolve(this._fsPath, '..', url);
            }
            vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url));
            break;
          }
        }
      },
      null,
      this._disposables
    );

    // Clean up the timeout when the panel is disposed for other reasons
    this._panel.onDidDispose(() => {
      if (this._disposalTimeout) {
        clearTimeout(this._disposalTimeout);
        this._disposalTimeout = null;
      }
      // Existing disposal code...
    }, null, this._disposables);
    
    // Log when panel becomes active/inactive
    this._panel.onDidChangeViewState((e) => {
      console.log(`Panel view state changed for ${this._uri.toString()}: active=${e.webviewPanel.active}, visible=${e.webviewPanel.visible}`);
    }, null, this._disposables);
  }

  static getAssetsFolder(uri: vscode.Uri) {
    const imageSaveFolder = (
      EditorPanel.config.get<string>('imageSaveFolder') || 'assets'
    )
      .replace(
        '${projectRoot}',
        vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath || ''
      )
      .replace('${file}', uri.fsPath)
      .replace(
        '${fileBasenameNoExtension}',
        NodePath.basename(uri.fsPath, NodePath.extname(uri.fsPath))
      )
      .replace('${dir}', NodePath.dirname(uri.fsPath));
    const assetsFolder = NodePath.resolve(
      NodePath.dirname(uri.fsPath),
      imageSaveFolder
    );
    return assetsFolder;
  }

  
  public dispose() {
    console.log(`Disposing EditorPanel for ${this._uri.toString()}`);

    // Unregister from the map
    EditorPanelMap.unregister(this._uri);

    // Clean up our resources
    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _init() {
    const webview = this._panel.webview;

    this._panel.webview.html = this._getHtmlForWebview(webview);
    this._panel.title = NodePath.basename(this._fsPath);
  }
  
  private _isEdit = false;
  
  private _updateEditTitle() {
    const isEdit = this._document.isDirty;
    if (isEdit !== this._isEdit) {
      this._isEdit = isEdit;
      this._panel.title = `${isEdit ? `[edit]` : ''}${NodePath.basename(
        this._fsPath
      )}`;
    }
  }

  private async _update(
    props: {
      type?: 'init' | 'update';
      options?: any;
      theme?: 'dark' | 'light';
    } = { options: void 0 }
  ) {
    const md = this._document
      ? this._document.getText()
      : (await vscode.workspace.fs.readFile(this._uri)).toString();
    // const dir = NodePath.dirname(this._document.fileName);
    this._panel.webview.postMessage({
      command: 'update',
      content: md,
      ...props,
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const toUri = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, f));
    const baseHref =
      NodePath.dirname(
        webview.asWebviewUri(vscode.Uri.file(this._fsPath)).toString()
      ) + '/';
    const toMediaPath = (f: string) => `media/dist/${f}`;
    const JsFiles = ['main.js'].map(toMediaPath).map(toUri);
    const CssFiles = ['main.css'].map(toMediaPath).map(toUri);

    return (
      `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<base href="${baseHref}" />


				${CssFiles.map((f) => `<link href="${f}" rel="stylesheet">`).join('\n')}

				<title>markdown editor</title>
        <style>` +
      EditorPanel.config.get<string>('customCss') +
      `</style>
			</head>
			<body>
				<div id="app"></div>


				${JsFiles.map((f) => `<script src="${f}"></script>`).join('\n')}
			</body>
			</html>`
    );
  }
}
