const F = window.__forge;
F.state.workspace = '/Users/airtechsolutions/Downloads/forge-demo';
F.updateWorkspaceUi();
await F.initTree();
F.state.model = (await window.studio.getModels())[0]?.id ?? F.state.model;
F.renderModelButton();
'boot ok'
