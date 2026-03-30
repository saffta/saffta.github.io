document.addEventListener('DOMContentLoaded', () => {
  // Intersection Observer for scroll reveal
  const observerOptions = {
    threshold: 0.1
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('active');
        observer.unobserve(entry.target);
      }
    });
  }, observerOptions);

  document.querySelectorAll('.reveal').forEach(el => {
    observer.observe(el);
  });

  // Typing effect for hero title
  // Lightbox Functionality
  const lightbox = document.createElement('div');
  lightbox.className = 'lightbox';
  document.body.appendChild(lightbox);

  const lightboxContent = document.createElement('div');
  lightboxContent.className = 'lightbox-content';
  lightbox.appendChild(lightboxContent);

  const lightboxImg = document.createElement('img');
  lightboxContent.appendChild(lightboxImg);

  const lightboxClose = document.createElement('div');
  lightboxClose.className = 'lightbox-close';
  lightboxClose.innerHTML = '&times;';
  lightboxContent.appendChild(lightboxClose);

  const openLightbox = (src) => {
    lightboxImg.src = src;
    lightbox.classList.add('active');
  };

  document.querySelectorAll('.gallery-item img, .gallery-img, .zoomable').forEach(img => {
    img.addEventListener('click', () => openLightbox(img.src));
  });

  lightbox.addEventListener('click', (e) => {
    if (e.target !== lightboxImg) {
      lightbox.classList.remove('active');
    }
  });

  // Multi-target typing effect
  const typeAll = () => {
    document.querySelectorAll('.typing-text').forEach(el => {
      const text = el.getAttribute('data-text');
      if (!text || el.classList.contains('typed')) return;

      let index = 0;
      el.textContent = '';
      el.classList.add('typed');

      function typeChar() {
        if (index < text.length) {
          el.textContent += text.charAt(index);
          index++;
          setTimeout(typeChar, 100);
        }
      }
      
      setTimeout(typeChar, 500);
    });
  };

  typeAll();

  // Smooth scroll for nav links
  document.querySelectorAll('header a').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      if (this.getAttribute('href').startsWith('#')) {
        e.preventDefault();
        const targetId = this.getAttribute('href').substring(1);
        const targetElement = document.getElementById(targetId);
        if (targetElement) {
          targetElement.scrollIntoView({ behavior: 'smooth' });
        }
      }
    });
  });
});
