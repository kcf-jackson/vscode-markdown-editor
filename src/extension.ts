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
      vscode.window.showErrorMessage(`Failed to open markdown editor: ${error.message}`);
      
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
    // Fix: Convert boolean to void
    return vscode.workspace.saveAll(false).then(() => {});
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

  // In EditorPanelMap
  private static openDocuments = new Map<string, vscode.TextDocument>();

  public static trackDocument(uri: string, document: vscode.TextDocument) {
    this.openDocuments.set(uri, document);
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

  // In the EditorPanelMap class
  public static keepDocumentsAlive() {
    // Iterate through all panels and ensure their documents are open
    for (const [uri, panel] of this.panels.entries()) {
      vscode.workspace.openTextDocument(vscode.Uri.parse(uri)).then(doc => {
        panel._document = doc; // Update the panel's document reference
      });
    }
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

  private _keepAliveInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    public readonly _panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    public _document: vscode.TextDocument, // 当前有 markdown 编辑器
    public _uri = _document.uri // 从资源管理器打开，只有 uri 没有 _document
  ) {
    // Set the webview's initial html content
    console.log(`Creating EditorPanel for ${this._uri.toString()}`);

    this._init();

    // Listen for when the panel is disposed
    // This happens when the user closes the panel or when the panel is closed programmatically
    // Track document reopening explicitly
    let closedDocumentPaths = new Set<string>();

    // Track document reopening with a timeout mechanism
    let disposalTimeout: NodeJS.Timeout | null = null;

    vscode.workspace.onDidCloseTextDocument((e) => {
      console.log(`Document closed: ${e.fileName}, comparing with ${this._fsPath}`);
      if (e.fileName === this._fsPath) {
        this._documentCloseTriggered = true;
        
        // Try to reopen the document immediately
        vscode.workspace.openTextDocument(this._uri).then(doc => {
          console.log(`Reopened document: ${doc.fileName}`);
          // Keep the document in the background
          return vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
        }).then(() => {
          console.log(`Document shown in editor`);
        }, (error: Error) => {
          console.error(`Failed to reopen document: ${error.message}`);
          // If we can't reopen, allow disposal
          this._keepAlive = false;
          this.dispose();
        });
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
    
    let textEditTimer: NodeJS.Timeout | void;
    
    // Track when files are saved
    vscode.workspace.onDidSaveTextDocument((e) => {
      console.log(`Document saved: ${e.fileName}`);
    }, this._disposables);

    // Track when editors are opened/closed
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      console.log(`Visible editors changed. Current count: ${editors.length}`);
      editors.forEach(editor => {
        console.log(`  - Editor: ${editor.document.fileName}`);
      });
    }, this._disposables);

    // Track active editor changes
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      console.log(`Active editor changed: ${editor?.document.fileName || 'none'}`);
    }, this._disposables);

    // Track when the webview becomes active/inactive
    this._panel.onDidChangeViewState((e) => {
      console.log(`Panel view state changed for ${this._uri.toString()}: active=${e.webviewPanel.active}, visible=${e.webviewPanel.visible}`);
      
      // Log the current state of all documents
      console.log(`Current open documents:`);
      vscode.workspace.textDocuments.forEach(doc => {
        console.log(`  - ${doc.fileName} (isDirty=${doc.isDirty}, isClosed=${doc.isClosed})`);
      });
    }, this._disposables);

    // Track document state changes
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.fileName === this._fsPath) {
        console.log(`Document changed: ${e.document.fileName}, isDirty=${e.document.isDirty}`);
      }
    }, this._disposables);
    
    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        debug('msg from webview review', message, this._panel.active);

        const syncToEditor = async () => {
          debug('sync to editor', this._document, this._uri);
          if (this._document) {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
              this._document.uri,
              new vscode.Range(0, 0, this._document.lineCount, 0),
              message.content
            );
            await vscode.workspace.applyEdit(edit);
          } else if (this._uri) {
            await vscode.workspace.fs.writeFile(this._uri, message.content);
          } else {
            showError(`Cannot find original file to save!`);
          }
        };
        
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
          case 'edit': {
            // 只有当 webview 处于编辑状态时才同步到 vsc 编辑器，避免重复刷新
            if (this._panel.active) {
              await syncToEditor();
              this._updateEditTitle();
            }
            break;
          }
          case 'reset-config': {
            await this._context.globalState.update(KeyVditorOptions, {});
            break;
          }
          case 'save': {
            await syncToEditor();
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
      closedDocumentPaths.delete(this._fsPath);

      if (disposalTimeout) {
        clearTimeout(disposalTimeout);
        disposalTimeout = null;
      }
      // Existing disposal code...
    }, null, this._disposables);


    // Add to constructor
    this._keepAliveInterval = setInterval(() => {
      if (this._document) {
        // Just accessing the document keeps it alive
        console.log(`Keeping document alive: ${this._document.fileName}, isDirty=${this._document.isDirty}`);
      } else {
        // If document was closed, try to reopen it
        vscode.workspace.openTextDocument(this._uri).then(doc => {
          this._document = doc;
          console.log(`Reopened document: ${doc.fileName}`);
        });
      }
    }, 30000); // Every 30 seconds

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

  
  // Keep track of whether this panel should be kept alive
  private _keepAlive = true;

  // Override the dispose method to check the keepAlive flag
  public dispose() {
    // If keepAlive is true and this is triggered by document close, prevent disposal
    if (this._keepAlive && this._documentCloseTriggered) {
      console.log(`Preventing disposal of panel for ${this._uri.toString()} due to keepAlive flag`);
      this._documentCloseTriggered = false;
      return;
    }
    // Check if already disposed to prevent multiple disposals
    if (this._isDisposed) {
      console.log(`Panel already disposed for ${this._uri.toString()}, skipping`);
      return;
    }
    
    this._isDisposed = true;
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

    // In the dispose() method or wherever you're clearing the interval
    if (this._keepAliveInterval) {
      clearInterval(this._keepAliveInterval);
      this._keepAliveInterval = null;
    }

  }
  
  // Add this property to the class
  private _documentCloseTriggered = false;
  private _isDisposed = false;
  

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
