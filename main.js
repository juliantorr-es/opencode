/**
 * Tribunus.dev — Main Script
 * Vanilla JS, zero dependencies, ES modules compatible.
 * Handles: scroll reveals, view transitions, smooth nav, nav opacity.
 */
(function () {
  'use strict';

  /* ---- Cached DOM queries ---- */
  const navBar = document.getElementById('nav-bar');
  const heroSection = document.getElementById('hero');
  const revealElements = document.querySelectorAll('[data-reveal]');
  const navLinks = document.querySelectorAll('.nav-cta, .hero-cta, .nav-logo');

  /* ---- IntersectionObserver: Nav background on scroll ---- */
  if (heroSection) {
    const navObserver = new IntersectionObserver(
      ([entry]) => {
        navBar.classList.toggle('nav-bar--scrolled', !entry.isIntersecting);
      },
      { threshold: [0, 1], rootMargin: '-64px 0px 0px 0px' }
    );
    navObserver.observe(heroSection);
  }

  /* ---- IntersectionObserver: Scroll reveal ---- */
  if (revealElements.length > 0) {
    const revealObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('revealed');
            revealObserver.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
    );

    for (const el of revealElements) {
      revealObserver.observe(el);
    }
  }

  /* ---- Smooth scroll with View Transitions ---- */
  function scrollToSection(target) {
    const id = target.getAttribute('href');
    if (!id || !id.startsWith('#')) return;
    const section = document.querySelector(id);
    if (!section) return;

    const doScroll = () => {
      const navHeight = navBar ? navBar.getBoundingClientRect().height : 56;
      const top = section.getBoundingClientRect().top + window.scrollY - navHeight;
      window.scrollTo({ top, behavior: 'smooth' });
    };

    // Use View Transitions API when available
    if (document.startViewTransition) {
      document.startViewTransition(() => {
        doScroll();
      });
    } else {
      doScroll();
    }
  }

  /* ---- Event delegation for nav links & CTA ---- */
  for (const link of navLinks) {
    link.addEventListener('click', (e) => {
      const href = link.getAttribute('href');
      if (href && href.startsWith('#')) {
        e.preventDefault();
        scrollToSection(link);
      }
    });
  }

  /* ---- Delegate clicks on any anchor with hash href (future-proofing) ---- */
  document.addEventListener(
    'click',
    (e) => {
      const link = e.target.closest('a[href^="#"]');
      if (!link) return;
      // Only handle if not already covered above (skip-link, etc.)
      if (link.closest('.nav-bar') || link.closest('.hero')) return;
      e.preventDefault();
      scrollToSection(link);
    },
    { passive: false }
  );
})();
