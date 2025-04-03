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
    // Check if the feature is enabled in settings
    const config = vscode.workspace.getConfiguration('markdown-editor');
    const useAsDefault = config.get<boolean>('useAsDefault', false);
    
    if (!useAsDefault) {
      // If not set as default, close this panel and open in regular editor
      webviewPanel.dispose();
      await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
      return;
    }

    try {
      // First, ensure the text document is open in the background
      const textDocument = await vscode.workspace.openTextDocument(document.uri);
      
      // Create a new editor panel using the existing webview panel
      await EditorPanelMap.createWithExistingPanel(this.context, textDocument, webviewPanel);
    } catch (error) {
      console.error("Failed to initialize markdown editor:", error);
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

  constructor(
    private readonly _context: vscode.ExtensionContext,
    public readonly _panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    public _document: vscode.TextDocument, // 当前有 markdown 编辑器
    public _uri = _document.uri // 从资源管理器打开，只有 uri 没有 _document
  ) {
    // Set the webview's initial html content
    this._init();

    // Listen for when the panel is disposed
    // This happens when the user closes the panel or when the panel is closed programmatically
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    
    let textEditTimer: NodeJS.Timeout | void;
    
    // close EditorPanel when vsc editor is close
    vscode.workspace.onDidCloseTextDocument((e) => {
      if (e.fileName === this._fsPath) {
        this.dispose();
      }
    }, this._disposables);
    
    // update EditorPanel when vsc editor changes
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.fileName !== this._document.fileName) {
        return;
      }
      // 当 webview panel 激活时不将由 webview编辑导致的 vsc 编辑器更新同步回 webview
      // don't change webview panel when webview panel is focus
      if (this._panel.active) {
        return;
      }
      textEditTimer && clearTimeout(textEditTimer);
      textEditTimer = setTimeout(() => {
        this._update();
        this._updateEditTitle();
      }, 300);
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
