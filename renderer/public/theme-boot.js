// renderer/public/theme-boot.js
// 防白闪：在首帧绘制前根据持久化主题给 <html> 设置 .dark class。
// - 必须是经典 <script>（parser 阻塞）；module 会 defer 到首绘后执行，起不到防闪作用
// - 必须是外置文件；CSP script-src 'self' 禁止内联脚本
// - 与 theme.store 的初始化 applyTheme 幂等双保险
(function () {
  try {
    var m = localStorage.getItem('momo.theme');
    if (
      m === 'dark' ||
      (m !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    ) {
      document.documentElement.classList.add('dark');
    }
  } catch (e) {
    // localStorage 不可用则维持明亮默认
  }
})();
