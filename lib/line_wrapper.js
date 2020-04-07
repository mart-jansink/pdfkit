import { EventEmitter } from 'events';
import LineBreaker from 'linebreak';

class LineWrapper extends EventEmitter {
  constructor(document, options) {
    super();
    this.document = document;
    this.indent = options.indent || 0;
    this.characterSpacing = options.characterSpacing || 0;
    this.wordSpacing = options.wordSpacing === 0;
    this.columns = options.columns || 1;
    this.columnGap = options.columnGap != null ? options.columnGap : 18; // 1/4 inch
    this.lineWidth =
      (options.width - this.columnGap * (this.columns - 1)) / this.columns;
    this.spaceLeft = this.lineWidth;
    this.startX = this.document.x;
    this.startY = this.document.y;
    this.column = 1;
    this.continuedX = 0;
    this.features = options.features;

    // normalize the ellipsis option
    if (options.ellipsis != null) {
      this._initEllipsisOptions(options.ellipsis);
    }

    // calculate the maximum Y position the text can appear at
    if (options.height != null) {
      this.height = options.height;
      this.maxY = this.startY + options.height;
    } else {
      this.maxY = this.document.page.maxY();
    }

    // handle paragraph indents
    this.on('firstLine', options => {
      // if this is the first line of the text segment, and
      // we're continuing where we left off, indent that much
      // otherwise use the user specified indent option
      const indent = this.continuedX || this.indent;
      this.document.x += indent;
      this.lineWidth -= indent;

      return this.once('line', () => {
        this.document.x -= indent;
        this.lineWidth += indent;
        if (options.continued && !this.continuedX) {
          this.continuedX = this.indent;
        }
        if (!options.continued) {
          return (this.continuedX = 0);
        }
      });
    });

    // handle left aligning last lines of paragraphs
    this.on('lastLine', options => {
      const { align } = options;
      if (align === 'justify') {
        options.align = 'left';
      }
      this.lastLine = true;

      return this.once('line', () => {
        this.document.y += options.paragraphGap || 0;
        options.align = align;
        return (this.lastLine = false);
      });
    });
  }

  wordWidth(word) {
    return (
      this.document.widthOfString(word, this) +
      this.characterSpacing +
      this.wordSpacing
    );
  }

  eachWord(text, fn) {
    // setup a unicode line breaker
    let bk;
    const breaker = new LineBreaker(text);
    let last = null;
    const wordWidths = Object.create(null);

    while ((bk = breaker.nextBreak())) {
      var shouldContinue;
      let word = text.slice(
        (last != null ? last.position : undefined) || 0,
        bk.position
      );
      let w =
        wordWidths[word] != null
          ? wordWidths[word]
          : (wordWidths[word] = this.wordWidth(word));

      // if the word is longer than the whole line, chop it up
      // TODO: break by grapheme clusters, not JS string characters
      if (w > this.lineWidth + this.continuedX) {
        // make some fake break objects
        let lbk = last;
        const fbk = {};

        while (word.length) {
          // fit as much of the word as possible into the space we have
          var l, mightGrow;
          if (w > this.spaceLeft) {
            // start our check at the end of our available space - this method is faster than a loop of each character and it resolves
            // an issue with long loops when processing massive words, such as a huge number of spaces
            l = Math.ceil(this.spaceLeft / (w / word.length));
            w = this.wordWidth(word.slice(0, l));
            mightGrow = w <= this.spaceLeft && l < word.length;
          } else {
            l = word.length;
          }
          let mustShrink = w > this.spaceLeft && l > 0;
          // shrink or grow word as necessary after our near-guess above
          while (mustShrink || mightGrow) {
            if (mustShrink) {
              w = this.wordWidth(word.slice(0, --l));
              mustShrink = w > this.spaceLeft && l > 0;
            } else {
              w = this.wordWidth(word.slice(0, ++l));
              mustShrink = w > this.spaceLeft && l > 0;
              mightGrow = w <= this.spaceLeft && l < word.length;
            }
          }

          // check for the edge case where a single character cannot fit into a line.
          if (l === 0 && this.spaceLeft === this.lineWidth) {
            l = 1;
          }

          // send a required break unless this is the last piece and a linebreak is not specified
          fbk.required = bk.required || l < word.length;
          shouldContinue = fn(word.slice(0, l), w, fbk, lbk);
          lbk = { required: false };

          // get the remaining piece of the word
          word = word.slice(l);
          w = this.wordWidth(word);

          if (shouldContinue === false) {
            break;
          }
        }
      } else {
        // otherwise just emit the break as it was given to us
        shouldContinue = fn(word, w, bk, last);
      }

      if (shouldContinue === false) {
        break;
      }
      last = bk;
    }
  }

  wrap(text, options) {
    // override options from previous continued fragments
    if (options.indent != null) {
      this.indent = options.indent;
    }
    if (options.characterSpacing != null) {
      this.characterSpacing = options.characterSpacing;
    }
    if (options.wordSpacing != null) {
      this.wordSpacing = options.wordSpacing;
    }
    if (options.ellipsis != null) {
      this._initEllipsisOptions(options.ellipsis);
    }

    // make sure we're actually on the page
    // and that the first line of is never by
    // itself at the bottom of a page (orphans)
    const nextY = this.document.y + this.document.currentLineHeight(true);
    if (this.document.y > this.maxY || nextY > this.maxY) {
      this.nextSection();
    }

    let buffer = '';
    let textWidth = 0;
    let wc = 0;
    let lc = 0;

    let { y } = this.document; // used to reset Y pos if options.continued (below)
    const emitLine = () => {
      options.textWidth = textWidth + this.wordSpacing * (wc - 1);
      options.wordCount = wc;
      options.lineWidth = this.lineWidth;
      ({ y } = this.document);
      this.emit('line', buffer, options, this);
      return lc++;
    };

    this.emit('sectionStart', options, this);

    this.eachWord(text, (word, w, bk, last) => {
      if (last == null || last.required) {
        this.emit('firstLine', options, this);
        this.spaceLeft = this.lineWidth;
      }

      if (w <= this.spaceLeft) {
        buffer += word;
        textWidth += w;
        wc++;
      }

      if (bk.required || w > this.spaceLeft) {
        // if the user specified a max height and an ellipsis, and is about to pass the
        // max height and max columns after the next line, append the ellipsis
        const lh = this.document.currentLineHeight(true);
        if (
          this.height != null &&
          this.ellipsis &&
          this.document.y + lh * 2 > this.maxY &&
          this.column >= this.columns
        ) {
          buffer = buffer.replace(/\s+$/, '');
          textWidth = this.wordWidth(buffer + this.ellipsis.character);

          // remove characters from the buffer until the ellipsis fits,
          // to avoid infinite loop need to stop while-loop if buffer is empty string
          while (buffer && textWidth > this.lineWidth) {
            switch (this.ellipsis.location) {
              case 'start':
                buffer = buffer.slice(1).replace(/\s+$/, '');
                break;

              case 'middle':
                const middle = Math.floor(buffer.length / 2);
                buffer = buffer.slice(0, middle) + buffer.slice(middle + 1);
                break;

              case 'end':
                buffer = buffer.slice(0, -1).replace(/\s+$/, '');
                break;
            }
            textWidth = this.wordWidth(buffer + this.ellipsis.character);
          }
          // need to add ellipsis only if there is enough space for it
          if (textWidth <= this.lineWidth) {
            switch (this.ellipsis.location) {
              case 'start':
                buffer = this.ellipsis.character + buffer;
                break;

              case 'middle':
                const middle = Math.floor(buffer.length / 2);
                buffer = buffer.slice(0, middle) + this.ellipsis.character + buffer.slice(middle);
                break;

              case 'end':
                buffer = buffer + this.ellipsis.character;
                break;
            }
          }

          textWidth = this.wordWidth(buffer);
        }

        if (bk.required) {
          if (w > this.spaceLeft) {
            emitLine();
            buffer = word;
            textWidth = w;
            wc = 1;
          }

          this.emit('lastLine', options, this);
        }

        emitLine();

        // if we've reached the edge of the page,
        // continue on a new page or column
        if (this.document.y + lh > this.maxY) {
          const shouldContinue = this.nextSection();

          // stop if we reached the maximum height
          if (!shouldContinue) {
            wc = 0;
            buffer = '';
            return false;
          }
        }

        // reset the space left and buffer
        if (bk.required) {
          this.spaceLeft = this.lineWidth;
          buffer = '';
          textWidth = 0;
          return (wc = 0);
        } else {
          // reset the space left and buffer
          this.spaceLeft = this.lineWidth - w;
          buffer = word;
          textWidth = w;
          return (wc = 1);
        }
      } else {
        return (this.spaceLeft -= w);
      }
    });

    if (wc > 0) {
      this.emit('lastLine', options, this);
      emitLine();
    }

    this.emit('sectionEnd', options, this);

    // if the wrap is set to be continued, save the X position
    // to start the first line of the next segment at, and reset
    // the y position
    if (options.continued === true) {
      if (lc > 1) {
        this.continuedX = 0;
      }
      this.continuedX += options.textWidth || 0;
      return (this.document.y = y);
    } else {
      return (this.document.x = this.startX);
    }
  }

  nextSection(options) {
    this.emit('sectionEnd', options, this);

    if (++this.column > this.columns) {
      // if a max height was specified by the user, we're done.
      // otherwise, the default is to make a new page at the bottom.
      if (this.height != null) {
        return false;
      }

      this.document.addPage();
      this.column = 1;
      this.startY = this.document.page.margins.top;
      this.maxY = this.document.page.maxY();
      this.document.x = this.startX;
      if (this.document._fillColor) {
        this.document.fillColor(...this.document._fillColor);
      }
      this.emit('pageBreak', options, this);
    } else {
      this.document.x += this.lineWidth + this.columnGap;
      this.document.y = this.startY;
      this.emit('columnBreak', options, this);
    }

    this.emit('sectionStart', options, this);
    return true;
  }

  _initEllipsisOptions(options) {
    if (options === false) {
      this.ellipsis = false;
    }
    else {
      this.ellipsis = Object.assign({}, {
        location: 'end',
        character: '…',
      });
      if (options !== true) {
        if ( typeof options === 'string') {
          switch (options) {
            case 'start':
            case 'middle':
            case 'end':
              this.ellipsis.location = options;
              break;

            default:
              this.ellipsis.character = options;
              break;
          }
        }
        else {
          Object.assign(this.ellipsis, options);
        }
      }
    }
  }
}

export default LineWrapper;
