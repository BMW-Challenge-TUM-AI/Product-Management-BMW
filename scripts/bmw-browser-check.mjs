import {chromium,expect} from '@playwright/test';

const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage();
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
const results=[];
const pass=name=>{results.push(name);console.log('PASS',name);};
const nav=async name=>{
 await page.locator('.sidebar nav').getByRole('button',{name,exact:name!=='Review Queue'}).click();
 await expect(page.locator('h1')).toHaveText(name);
};

try{
 await page.goto('http://127.0.0.1:5173',{waitUntil:'domcontentloaded'});
 await expect(page.locator('h1')).toHaveText('Overview');
 await nav('Data Sources');
 await expect(page.getByRole('heading',{name:'BMW data library'})).toBeVisible();
 await expect(page.locator('.bmw-library')).toContainText('1,433 distinct feedback comments');
 await expect(page.locator('.bmw-library')).toContainText('3,010 source annotation rows');
 pass('F70/Europe statistics distinguish unique comments from source annotation rows');

 const pdf=page.locator('.bmw-project-file').filter({hasText:'F70_OptionList.PDF'});
 await expect(pdf).toBeVisible();
 await pdf.getByRole('button',{name:'Read file'}).click();
 await expect(page.getByRole('dialog')).toContainText('Page 1');
 const pdfText=await page.getByRole('dialog').locator('.source-page-text').first().textContent();
 expect(pdfText?.trim().length).toBeGreaterThan(0);
 await expect(page.getByRole('dialog')).toContainText('parsed by the shared project-file reader');
 await page.getByRole('dialog').getByRole('button',{name:'Close dialog'}).click();
 pass('An arbitrary project PDF opens as page-level source records');

 const workbook=page.locator('.bmw-project-file').filter({hasText:'F70_G60_G68_G70_customer_studies.xlsx'});
 await workbook.getByRole('button',{name:'Read file'}).click();
 await expect(page.getByRole('dialog')).toContainText('CN_EU_2025');
 await expect(page.getByRole('dialog')).toContainText('US_2025');
 await page.getByRole('dialog').getByRole('button',{name:'Close dialog'}).click();
 pass('A project workbook opens by sheet with source-row locations');

 await page.getByLabel('BMW library series').selectOption('5');
 await expect(page.locator('.bmw-library')).toContainText('3,610 distinct feedback comments');
 await expect(page.locator('.bmw-library')).toContainText('4,365 source annotation rows');
 pass('G60/United States count matches the workbook ID and row totals');

 await page.getByLabel('BMW library series').selectOption('7');
 await expect(page.locator('.bmw-library')).toContainText('3,792 distinct feedback comments');
 await expect(page.locator('.bmw-library')).toContainText('4,418 source annotation rows');
 pass('G70/United States count matches the workbook ID and row totals');

 await page.getByLabel('BMW library series').selectOption('5');
 await page.getByLabel('BMW library market').selectOption('CN');
 await expect(page.locator('.bmw-library')).toContainText('No customer feedback was supplied');
 await page.getByRole('button',{name:'Load this series + market'}).click();
 await expect(page.locator('.context-switcher')).toContainText('BMW 5 Series G68');
 await expect(page.locator('.context-switcher')).toContainText('China');
 await expect(page.locator('.source-card')).toContainText('Customer study');
 await expect(page.locator('.source-card')).toContainText('Sales volumes');
 await expect(page.locator('.source-card').filter({hasText:'Customer verbatims'})).toHaveCount(0);
 pass('G68/China loads supplied reference data without inventing customer feedback');

 await page.setViewportSize({width:390,height:844});
 await expect.poll(async()=>page.locator('.sidebar').evaluate(element=>Math.round(element.getBoundingClientRect().right))).toBeLessThanOrEqual(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 await expect(page.getByRole('heading',{name:'Project XLSX and PDF files'})).toBeVisible();
 pass('Project file reader remains usable on a mobile viewport');

 expect(errors).toEqual([]);
 console.log(`${results.length} source-backed browser scenarios passed.`);
}catch(error){
 console.error(error);
 await page.screenshot({path:'artifacts/bmw-library-failure.png',fullPage:true}).catch(()=>{});
 process.exitCode=1;
}finally{
 await browser.close();
}
